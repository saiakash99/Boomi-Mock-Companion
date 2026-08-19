'use strict';

// ============================================================
// Boomi Companion — Autonomous Live Test & Routing Audit
// Run: node test/autonomous-live.js
//
// WHAT THIS IS
//   A zero-dependency live harness that launches the REAL Electron app,
//   drives the global hotkeys through the OS (WScript.Shell SendKeys),
//   streams the newest diagnostics .jsonl session in real time, injects
//   synthetic interview questions straight into the live engine, and
//   produces a routing table that shows, for every injected question,
//   which provider + pooled API key served it, the status, and any
//   fallback action.
//
// DRIVE MECHANISM
//   - Electron is launched with --remote-debugging-port so the renderer can
//     be driven over the Chrome DevTools Protocol (Runtime.evaluate). The
//     app's engine, providerRouter and DOM are all reachable from the CDP
//     main world, exactly like a DevTools console session.
//   - Hotkeys are sent as REAL OS input via PowerShell WScript.Shell.SendKeys
//     ("%s", "%h", "%m", "%c"). Electron's globalShortcut registers these
//     OS-wide, so the overlay never needs focus (same as real usage).
//   - Synthetic questions are injected with engine.processTranscript(text,
//     true, true) — a mocked Deepgram final+speech_final frame, the exact
//     path the real WebSocket onmessage handler takes.
//
// ROUTING DETECTION
//   Reads the live .jsonl session (logs/session-*.jsonl) and watches for
//   PROVIDER_SUCCESS / PROVIDER_FALLBACK / API_ERROR / EMERGENCY_RESPONSE
//   (plus PROVIDER_FAILURE etc.). The actual Groq key used per request is
//   derived from providerRouter._keyIndexes.groq (the router's round-robin
//   pointer) — the key strings themselves stay redacted by design.
//
// FLAGS
//   --port=<n>     CDP port (default 9333)
//   --close        close the Electron app when the harness exits
//   --keep-open    leave the Electron app running when the harness exits
//                  (default in non-interactive mode; in an interactive TTY
//                   the harness waits for Enter after the vision message)
// ============================================================

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1], 10) || 9333;
const MODE_CLOSE = process.argv.includes('--close');
const MODE_KEEP = process.argv.includes('--keep-open');
const TTY = Boolean(process.stdin && process.stdin.isTTY);

// ---- the three synthetic interviewer questions ---------------------------
const QUESTIONS = [
  { n: 1, q: 'What is the difference between an Atom and a Molecule?', expect: 'Groq Key 1' },
  { n: 2, q: 'How does Flow Control work?', expect: 'Groq Key 2' },
  { n: 3, q: 'Explain Dynamic Document Properties.', expect: 'Groq Key 3' }
];

// ---- helpers -------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isoStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON from ' + url + ': ' + body.slice(0, 120))); }
      });
    }).on('error', reject);
  });
}

async function cdpWaitReachable(port, tries = 60, every = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await httpGet(`http://127.0.0.1:${port}/json/list`);
      const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url || ''));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) { /* not up yet */ }
    await sleep(every);
  }
  throw new Error(`CDP endpoint not reachable on port ${port} within ${(tries * every) / 1000}s`);
}

function makeCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let msgId = 0;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error('CDP error: ' + JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error('CDP websocket error'));
  });
  async function send(method, params = {}) {
    await ready;
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evalJs(expression) {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('eval threw: ' + (d.exception?.description || d.text));
    }
    return res.result?.value;
  }
  return { ws, send, evalJs, ready };
}

// ---- JSONL session discovery + real-time streamer ------------------------

async function newestSessionFile() {
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(LOGS_DIR, b)).mtimeMs - fs.statSync(path.join(LOGS_DIR, a)).mtimeMs);
  return path.join(LOGS_DIR, files[0]);
}

const ROUTER_EVENTS = new Set([
  'PROVIDER_SUCCESS', 'PROVIDER_FALLBACK', 'PROVIDER_FAILURE',
  'PROVIDER_SKIPPED', 'PROVIDER_OFFLINE', 'PROVIDER_COOLDOWN',
  'PROVIDER_RECOVERED', 'API_ERROR', 'EMERGENCY_RESPONSE', 'ANSWER_DELIVERED',
  'ERROR'
]);

function tailJsonl(file, onEvent) {
  let fd = null;
  let pos = 0;
  let stopped = false;
  function open() {
    if (fs.existsSync(file)) fd = fs.openSync(file, 'r');
  }
  function pump() {
    if (stopped) return;
    try {
      if (!fd) { open(); }
      if (fd) {
        const st = fs.fstatSync(fd);
        if (st.size > pos) {
          const buf = Buffer.alloc(st.size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          pos = st.size;
          const text = buf.toString('utf8');
          for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            let ev;
            try { ev = JSON.parse(t); } catch (_) { continue; }
            if (ev.eventType) onEvent(ev);
          }
        }
      }
    } catch (_) { /* file rotated/unlinked — reopen next tick */ }
  }
  open();
  const timer = setInterval(pump, 200);
  pump();
  return {
    stop() { stopped = true; clearInterval(timer); try { if (fd) fs.closeSync(fd); } catch (_) {} }
  };
}

// ---- OS-level hotkey injection (real global shortcut) ---------------------

function sendHotkey(combo) {
  const keys = { 'Alt+S': '%s', 'Alt+H': '%h', 'Alt+M': '%m', 'Alt+C': '%c' }[combo];
  if (!keys) return Promise.reject(new Error('unknown hotkey ' + combo));
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).SendKeys('${keys}')`],
      { timeout: 15000, windowsHide: true },
      (err) => err ? reject(err) : resolve()
    );
  });
}

// ---- renderer state snapshot over CDP ------------------------------------

const STATE_EXPR = `(function () {
  var d = document.getElementById('settings-drawer');
  return {
    paused: engine.paused,
    state: engine.state,
    mode: engine.outputMode,
    outputMode: engine.outputMode,
    buffer: engine.questionBuffer,
    seq: engine.seq,
    drawerOpen: !!(d && d.classList.contains('open')),
    keyIndexes: { groq: providerRouter._keyIndexes.groq, openrouter: providerRouter._keyIndexes.openrouter, cerebras: providerRouter._keyIndexes.cerebras },
    keyCounts: { groq: providerRouter.groqKeys.length }
  };
})()`;

// ---- live routing-table row printing --------------------------------------

let liveRows = [];

function describeKey(ki, provider) {
  if (provider !== 'groq') return provider;
  const idx = (ki && ki.groq) || 0;
  const pool = (ki && ki.count) || 0;
  const used = pool ? ((idx - 1 + pool) % pool) + 1 : idx; // key ordinal that just served
  return `groq:key${used}`;
}

function logRouterEvent(ev, keyIndex) {
  const ts = (ev.timestamp || isoStamp()).slice(11, 23);

  let row = null;
  switch (ev.eventType) {
    case 'PROVIDER_SUCCESS':
      row = {
        ts,
        provider: describeKey(keyIndex, ev.provider),
        status: 'PROVIDER_SUCCESS',
        detail: `latencyMs=${ev.latencyMs}${ev.ttftMs != null ? ' ttftMs=' + ev.ttftMs : ''}${ev.fallback ? ' [FALLBACK]' : ''}`,
        fallback: ev.fallback ? `Failed over from groq -> ${ev.provider}` : 'None (primary)'
      };
      break;
    case 'PROVIDER_FALLBACK':
      row = { ts, provider: `${ev.from}->${ev.to}`, status: 'PROVIDER_FALLBACK', detail: `latencyMs=${ev.latencyMs}`, fallback: `Failover to ${ev.to}` };
      break;
    case 'PROVIDER_FAILURE':
      row = { ts, provider: ev.provider, status: 'PROVIDER_FAILURE', detail: `${ev.cls}${ev.status != null ? ' HTTP ' + ev.status : ''}`, fallback: 'Failing over to next provider' };
      break;
    case 'PROVIDER_SKIPPED':
      row = { ts, provider: ev.provider, status: 'PROVIDER_SKIPPED', detail: ev.breaker || '', fallback: 'Circuit breaker / missing key' };
      break;
    case 'PROVIDER_OFFLINE':
    case 'PROVIDER_COOLDOWN':
    case 'PROVIDER_RECOVERED':
      row = { ts, provider: ev.provider, status: ev.eventType.replace('PROVIDER_', ''), detail: ev.reason || '', fallback: ev.eventType === 'PROVIDER_RECOVERED' ? 'Back in rotation' : 'Removed from rotation' };
      break;
    case 'API_ERROR':
    case 'ERROR':
      row = { ts, provider: 'engine', status: 'API_ERROR', detail: String(ev.message || ev.error || (ev.context ? 'context=' + ev.context : '') || '').slice(0, 140), fallback: 'Emergency local response' };
      break;
    case 'EMERGENCY_RESPONSE':
      row = { ts, provider: 'local-emergency', status: 'EMERGENCY_RESPONSE', detail: `turnId=${ev.turnId || ''}`, fallback: 'Instant local Boomi answer' };
      break;
    case 'ANSWER_DELIVERED':
      row = { ts, provider: 'engine', status: 'ANSWER_DELIVERED', detail: `source=${ev.source}`, fallback: ev.source === 'cloud' ? 'Cloud answer promoted' : `Local (${ev.source})` };
      break;
    default:
      return;
  }
  if (row) {
    liveRows.push(row);
    console.log(`  [${row.ts}] | ${row.provider.padEnd(20)} | ${row.status.padEnd(20)} | ${row.detail}${row.fallback ? '  -> ' + row.fallback : ''}`);
  }
}

// ---- Electron lifecycle ---------------------------------------------------

let electronChild = null;

function launchElectron() {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_EXE, ['.', `--remote-debugging-port=${CDP_PORT}`], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    electronChild = child;
    child.on('error', reject);
    // drain stdout/stderr so the pipes never fill and block the child
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('exit', code => { electronChild = null; if (!shuttingDown) console.log(`  [HARNESS] Electron exited (code ${code})`); });
    setTimeout(resolve, 500);
  });
}

let shuttingDown = false;
async function closeApp(cdp) {
  if (cdp) {
    try { await cdp.evalJs('try { closeApp(); } catch (e) {}'); } catch (_) {}
    await sleep(800);
  }
  if (electronChild && electronChild.exitCode === null) {
    try { electronChild.kill(); } catch (_) {}
  }
}

// ---- the run --------------------------------------------------------------

async function main() {
  console.log('=== BOOMI COMPANION — AUTONOMOUS LIVE TEST & ROUTING AUDIT ===');
  console.log(`  Electron: ${ELECTRON_EXE}`);
  console.log(`  CDP port: ${CDP_PORT}   Mode: ${TTY ? 'interactive (Enter to finish)' : 'non-interactive'}`);

  // 0. Pre-snapshot the logs dir so we can detect the fresh session.
  const preLogs = new Set(fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl')) : []);

  // 1. Attach to an already-running instance or launch one.
  let cdp;
  let page;
  try {
    page = await cdpWaitReachable(CDP_PORT, 2, 400);
    console.log('  [HARNESS] Attached to an already-running Electron instance.');
  } catch (_) {
    console.log('  [HARNESS] Launching Electron...');
    await launchElectron();
    page = await cdpWaitReachable(CDP_PORT);
    console.log('  [HARNESS] Electron renderer reachable.');
  }
  cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  // 2. Wait for the fresh JSONL session file and stream it live.
  console.log('  [HARNESS] Waiting for a fresh diagnostics session log...');
  let sessionFile = null;
  for (let i = 0; i < 120 && !sessionFile; i++) {
    const files = (fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR) : []).filter(f => f.endsWith('.jsonl') && !preLogs.has(f));
    if (files.length) {
      files.sort((a, b) => fs.statSync(path.join(LOGS_DIR, b)).mtimeMs - fs.statSync(path.join(LOGS_DIR, a)).mtimeMs);
      sessionFile = path.join(LOGS_DIR, files[0]);
    } else {
      await sleep(500);
    }
  }
  if (!sessionFile) {
    // fall back to the newest existing session so the harness still works
    sessionFile = await newestSessionFile();
    console.log('  [WARN] No fresh session created — streaming the newest existing log.');
  } else {
    console.log(`  [HARNESS] Streaming: ${path.basename(sessionFile)}`);
  }

  // optional initial renderer sanity check
  const boot = await cdp.evalJs(`JSON.stringify({ready: document.readyState, title: document.title, keys: providerRouter.groqKeys.length})`);
  console.log(`  [HARNESS] Renderer boot state: ${boot}`);

  let liveKeyIndex = { groq: 0, count: 0 };
  const liveKeyRefresher = () =>
    cdp.evalJs(`({groq: providerRouter._keyIndexes.groq || 0, count: providerRouter.groqKeys.length || 0})`)
      .then(ki => { if (ki) liveKeyIndex = ki; })
      .catch(() => {});
  tailJsonl(sessionFile, async (ev) => {
    if (!ROUTER_EVENTS.has(ev.eventType)) return;
    if (ev.eventType === 'PROVIDER_SUCCESS' && ev.provider === 'groq') await liveKeyRefresher();
    logRouterEvent(ev, liveKeyIndex);
  });

  // 3. PHASE A — global hotkey audit (real OS keystrokes, 2s spacing).
  console.log('\n--- PHASE A: GLOBAL HOTKEY AUDIT (real OS keystrokes) ---');
  const hotkeyResults = [];
  async function hotkeyAudit(combo, verifyExpr, label) {
    const before = await cdp.evalJs(STATE_EXPR);
    await sendHotkey(combo);
    await sleep(2000);
    const after = await cdp.evalJs(STATE_EXPR);
    let verified = false;
    let note = '';
    try {
      const v = await cdp.evalJs(verifyExpr);
      verified = !!v;
      note = JSON.stringify(v);
    } catch (e) {
      note = 'verify eval failed: ' + e.message;
    }
    hotkeyResults.push({ combo, label, before, after, verified });
    console.log(`  ${combo.padEnd(6)} ${label.padEnd(26)} -> ${verified ? 'OK' : 'NOT VERIFIED'}  ${note}`);
    return after;
  }

  let snap = await hotkeyAudit('Alt+S', 'engine.paused === true', 'toggle-listen (pause)');
  snap = await hotkeyAudit('Alt+H', `document.getElementById('settings-drawer').classList.contains('open')`, 'shortcuts drawer');
  snap = await hotkeyAudit('Alt+M', "engine.outputMode === 'architect'", 'output mode -> architect');
  snap = await hotkeyAudit('Alt+C', "document.getElementById('answer-box').classList.contains('dimmed')", 'clear screen');
  // resume listening so the injected questions can be processed
  snap = await hotkeyAudit('Alt+S', 'engine.paused === false', 'toggle-listen (resume)');

  // 4. PHASE B — synthetic interview flow -> routing audit.
  console.log('\n--- PHASE B: SYNTHETIC INTERVIEW FLOW (injected Deepgram frames) ---');
  console.log('  [Timestamp] | [API Key/Provider Used] | [Status] | [Detail] -> [Fallback]');
  console.log('  ' + '-'.repeat(150));

  const routingTable = [];
  for (const item of QUESTIONS) {
    console.log(`\n  >>> Q${item.n}: "${item.q}"  (expect ${item.expect})`);
    const mark = isoStamp();

    const beforeIdx = await cdp.evalJs(`providerRouter._keyIndexes.groq || 0`);

    // inject a mocked final + speech_final Deepgram frame
    await cdp.evalJs(`engine.processTranscript(${JSON.stringify(item.q)}, true, true)`);

    // wait for router activity; sniper mode defers non-finalize boundaries
    const started = Date.now();
    let resolved = false;
    let forced = false;
    const startRowCount = liveRows.length;

    // Wait up to 8s for the boundary to finalize and route.
    while (Date.now() - started < 8000 && !resolved) {
      for (let i = startRowCount; i < liveRows.length; i++) {
        const r = liveRows[i];
        if (!r) continue;
        if (r.status === 'PROVIDER_SUCCESS' || r.status === 'PROVIDER_FALLBACK' || r.status === 'EMERGENCY_RESPONSE' || r.status === 'ANSWER_DELIVERED') resolved = true;
        if (r.status === 'API_ERROR') resolved = true;
      }
      await sleep(250);
    }

    // Sniper-mode deferral fallback: drive the final answer through the public
    // regenerate() path (the same pipeline Alt+R uses) so Q3 still routes.
    if (!resolved) {
      console.log(`  [!] Boundary deferred (non-finalize) — forcing the final answer via engine.regenerate() (Alt+R path)`);
      forced = true;
      await cdp.evalJs(`engine.regenerate()`);
      while (Date.now() - started < 30000) {
        for (let i = startRowCount; i < liveRows.length; i++) {
          const r = liveRows[i];
          if (!r) continue;
          if (r.status === 'PROVIDER_SUCCESS' || r.status === 'EMERGENCY_RESPONSE' || r.status === 'ANSWER_DELIVERED') resolved = true;
          if (r.status === 'API_ERROR') resolved = true;
        }
        if (resolved) break;
        await sleep(250);
      }
    }

    const afterIdx = await cdp.evalJs(`providerRouter._keyIndexes.groq || 0`);
    const keyCount = await cdp.evalJs(`providerRouter.groqKeys.length || 0`);

    // derive which pooled key served this question
    let usedKey = '?';
    let usedProvider = '?';
    let status = 'NO_ROUTING';
    let fallbackAction = 'none';
    const rows = liveRows.slice(startRowCount);
    const success = rows.find(r => r.status === 'PROVIDER_SUCCESS');
    const emergency = rows.find(r => r.status === 'EMERGENCY_RESPONSE');
    const apiErr = rows.find(r => r.status === 'API_ERROR');
    const delivered = rows.find(r => r.status === 'ANSWER_DELIVERED');
    if (success) {
      usedProvider = success.provider.startsWith('groq') ? 'groq' : success.provider;
      if (usedProvider === 'groq') usedKey = (afterIdx > 0) ? `key${((afterIdx - 1 + keyCount) % keyCount) + 1}` : `key${beforeIdx + 1}`;
      else usedKey = 'single';
      status = 'PROVIDER_SUCCESS';
      fallbackAction = success.fallback && success.fallback !== 'None (primary)' ? 'FAILOVER -> ' + usedProvider : 'None (primary)';
    } else if (emergency) {
      usedProvider = 'local-emergency';
      usedKey = 'none';
      status = 'EMERGENCY_RESPONSE';
      fallbackAction = 'Emergency local answer (all providers failed)';
    } else if (apiErr) {
      usedProvider = 'engine';
      usedKey = 'none';
      status = 'API_ERROR';
      fallbackAction = apiErr.fallback || 'Emergency local response';
    } else if (delivered) {
      usedProvider = delivered.detail.includes('source=cloud') ? 'groq-chain' : delivered.detail;
      usedKey = 'n/a';
      status = 'ANSWER_DELIVERED';
      fallbackAction = delivered.fallback || '';
    }

    routingTable.push({
      q: item.n,
      question: item.q,
      ts: mark.slice(11, 23),
      provider: usedProvider,
      key: usedKey,
      status,
      fallback: fallbackAction,
      forced
    });

    console.log(`      Q${item.n} route: ${usedProvider} ${usedKey} | ${status} | ${fallbackAction}`);
  }

  // 5. Final routing table.
  console.log('\n--- FINAL ROUTING TABLE (multi-provider audit) ---');
  const rows = routingTable.map(r => ({
    Q: r.q,
    Question: r.question,
    Timestamp: r.ts,
    'Provider/Key': `${r.provider}:${r.key}`,
    Status: r.status,
    'Fallback Action': r.fallback + (r.forced ? '  [forced via regenerate]' : '')
  }));
  console.table(rows);

  const providerSummary = {};
  for (const r of routingTable) {
    const k = `${r.provider}:${r.key}`;
    providerSummary[k] = (providerSummary[k] || 0) + 1;
  }
  console.log('\n  Provider/key usage across the 3 injected questions:');
  for (const [k, v] of Object.entries(providerSummary)) console.log(`    ${k} -> ${v} question(s)`);

  // 6. Vision verification pause.
  console.log('\n================================================================');
  console.log('Autonomous run complete. Please use VS Code Copilot Vision to capture');
  console.log('a screenshot of the Electron window now to verify the glassmorphism UI');
  console.log('and floating pill.');
  console.log(`(Session log: ${sessionFile})`);
  console.log('================================================================');

  if (TTY && !MODE_CLOSE) {
    console.log('\nPress Enter to close the Electron app (or leave it running and close this terminal).');
    await new Promise(res => process.stdin.once('data', () => res()));
  }

  if (MODE_CLOSE) {
    console.log('  [HARNESS] Closing the Electron app...');
    await closeApp(cdp);
  } else {
    console.log('\n  [HARNESS] Keeping the Electron overlay running for your screenshot.');
  }

  try { cdp.ws.close(); } catch (_) {}
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\n[HARNESS] FATAL:', err && err.stack || err);
  if (electronChild) {
    shuttingDown = true;
    try { electronChild.kill(); } catch (_) {}
  }
  process.exit(1);
});
