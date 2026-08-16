'use strict';

// ============================================================
// Boomi Companion — Phase 2A Diagnostic Logger test harness (Node, no DOM)
// Run: node test/diagnostics.test.js
//
// Covers the 14 required areas:
//   1. session creation          8.  boundary decision logging
//   2. event IDs                 9.  snapshot logging
//   3. timestamps               10.  turn archival logging
//   4. elapsed timing           11.  follow-up logging
//   5. JSONL validity           12.  clear/pause/resume logging
//   6. transcript logging       13.  no secret leakage
//   7. state transition logging 14.  bounded log behavior
// Plus an engine->logger integration scenario and SESSION_SUMMARY stats.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DiagnosticLogger, isoWithOffset } = require('../diagnostics.js');
const { InterviewEngine, STATES } = require('../engine.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  - ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL - ' + name + '\n        ' + (err && err.message));
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  - ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL - ' + name + '\n        ' + (err && err.message));
  }
}

const flush = () => new Promise(r => setImmediate(r));

// fresh temp dir per test group
function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdiag-'));
  return dir;
}

function makeLogger(dir, opts) {
  return new DiagnosticLogger(Object.assign({
    dir: dir,
    flushMs: 10,
    nowWall: () => 1752500000000,
    nowMonotonic: (() => {
      let t = 0;
      return () => (t += 1000); // deterministic monotonic clock
    })()
  }, opts || {}));
}

async function readLines(file) {
  const txt = await fs.promises.readFile(file, 'utf8');
  return txt.split('\n').filter(l => l.trim() !== '');
}

// ---------------- fake timer for engine integration ----------------
function makeTimer() {
  let now = 0;
  let idSeq = 0;
  const queue = [];
  return {
    getNow: () => now,
    advance(ms) {
      now += ms;
      let guard = 0;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = queue[0];
        if (!next || next.at > now) break;
        queue.shift();
        next.fn();
        if (++guard > 1000) throw new Error('fake timer runaway');
      }
    },
    setTimeout(fn, ms) {
      const id = ++idSeq;
      queue.push({ at: now + (ms || 0), id, fn });
      return id;
    },
    clearTimeout(id) {
      const i = queue.findIndex(t => t.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    pending() { return queue.length; }
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Mirrors the renderer's engine diag hook: emits the event and, on snapshot
// creation, records the 'snapshot' performance mark so latency is derived.
function makeDiag(l) {
  return (type, data) => {
    l.emit(type, data);
    if (type === 'QUESTION_SNAPSHOT_CREATED' && data && data.turnId) l.perfMark('snapshot', data.turnId);
  };
}

function makeMockCalls() {
  const calls = { fast: [], answer: [] };
  const pending = { fast: [], answer: [] };
  function recorder(list, pendingList) {
    return function (messages) {
      const d = deferred();
      list.push({ messages, text: messages[messages.length - 1].content, deferred: d, resolved: false });
      pendingList.push(list[list.length - 1]);
      return d.promise;
    };
  }
  return {
    calls,
    fastPathCall: recorder(calls.fast, pending.fast),
    answerCall: recorder(calls.answer, pending.answer),
    pendingFastCount: () => pending.fast.length,
    pendingAnswerCount: () => pending.answer.length,
    resolveNextFast(c) { pending.fast.shift().deferred.resolve(c); },
    resolveNextAnswer(c) { pending.answer.shift().deferred.resolve(c); }
  };
}

async function main() {
  console.log('\n== 1. Session creation ==');

  await checkAsync('start() creates sessionId + JSONL/txt files', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    assert.ok(/^session_\d{8}_\d{6}_\d{3}$/.test(l.sessionId), 'sessionId format, got ' + l.sessionId);
    assert.ok(/^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.jsonl$/.test(path.basename(l.jsonlPath)), 'jsonl file name');
    await l.flush();
    assert.ok(fs.existsSync(l.jsonlPath), 'jsonl file exists');
    assert.ok(fs.existsSync(l.txtPath), 'txt file exists');
  });

  await checkAsync('two sessions never overwrite each other', async () => {
    const dir = makeDir();
    const a = makeLogger(dir);
    const b = makeLogger(dir);
    a.start();
    b.start();
    await a.flush();
    await b.flush();
    assert.notStrictEqual(a.sessionId, b.sessionId);
    assert.notStrictEqual(a.jsonlPath, b.jsonlPath);
  });

  console.log('\n== 2. Event IDs ==');

  await checkAsync('event IDs are monotonic event_000001...', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    // SESSION_STARTED consumes event_000001
    const ev1 = l.emit('WARNING', { msg: 'a' });
    const ev2 = l.emit('WARNING', { msg: 'b' });
    const ev3 = l.emit('WARNING', { msg: 'c' });
    assert.strictEqual(ev1.eventId, 'event_000002');
    assert.strictEqual(ev2.eventId, 'event_000003');
    assert.strictEqual(ev3.eventId, 'event_000004');
    const n1 = parseInt(ev1.eventId.slice(6), 10);
    const n2 = parseInt(ev2.eventId.slice(6), 10);
    const n3 = parseInt(ev3.eventId.slice(6), 10);
    assert.strictEqual(n2 - n1, 1);
    assert.strictEqual(n3 - n2, 1);
  });

  await checkAsync('event IDs never reused within a session', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    const ids = new Set();
    for (let i = 0; i < 500; i++) {
      const ev = l.emit('WARNING', { n: i });
      ids.add(ev.eventId);
    }
    assert.strictEqual(ids.size, 500, 'all eventIds unique');
  });

  console.log('\n== 3. Timestamps ==');

  await checkAsync('timestamps are ISO-8601 with timezone offset', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    const ev = l.emit('WARNING', { msg: 'x' });
    assert.match(ev.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, 'offset format');
    assert.strictEqual(ev.timestamp, isoWithOffset(new Date(1752500000000)), 'matches helper');
  });

  console.log('\n== 4. Elapsed timing ==');

  await checkAsync('elapsedMs advances monotonically', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    const e1 = l.emit('WARNING', { n: 1 });
    const e2 = l.emit('WARNING', { n: 2 });
    assert.ok(e2.elapsedMs > e1.elapsedMs, 'elapsed increases');
    assert.strictEqual(e2.elapsedMs, e1.elapsedMs + 1000, 'deterministic +1000ms per event');
  });

  await checkAsync('elapsedMs is wall-clock independent', async () => {
    // nowMonotonic keeps ticking even though wall clock stays fixed;
    // start() consumes one tick, each event another.
    const dir = makeDir();
    let mono = 0;
    const l = new DiagnosticLogger({ dir, nowWall: () => 1752500000000, nowMonotonic: () => (mono += 500), flushMs: 10 });
    l.start(); // consumes tick -> startMonotonic = 500
    const e1 = l.emit('WARNING', {}); // tick 1000, SESSION_STARTED consumed 500 -> 1500? see below
    const e2 = l.emit('WARNING', {});
    // SESSION_STARTED emitted during start() consumed one tick (mono=1000).
    // e1 = tick 1500 - start 500 = 1000; e2 = tick 2000 - start 500 = 1500.
    assert.strictEqual(e1.elapsedMs, 1000);
    assert.strictEqual(e2.elapsedMs, 1500);
    assert.strictEqual(e1.timestamp, e2.timestamp); // wall clock unchanged
  });

  console.log('\n== 5. JSONL validity ==');

  await checkAsync('every written line is valid JSON with common fields', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('TRANSCRIPT_INTERIM', { transcript: 'hello world', wordCount: 2 });
    l.emit('BOUNDARY_DECISION', { decision: 'FINALIZE', reason: 'x' });
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    assert.ok(lines.length >= 2, 'at least the header events are written');
    for (const line of lines) {
      const ev = JSON.parse(line); // throws on invalid JSON
      assert.ok(ev.sessionId, 'sessionId present');
      assert.ok(ev.eventId, 'eventId present');
      assert.ok(ev.timestamp, 'timestamp present');
      assert.ok(typeof ev.elapsedMs === 'number', 'elapsedMs is a number');
      assert.ok(ev.eventType, 'eventType present');
    }
    // SESSION_STARTED must be the first event
    assert.strictEqual(JSON.parse(lines[0]).eventType, 'SESSION_STARTED');
  });

  console.log('\n== 6. Transcript event logging ==');

  await checkAsync('TRANSCRIPT_INTERIM/FINAL carry full transcript metadata', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('TRANSCRIPT_INTERIM', { transcript: 'How would you handle', transcriptLength: 22, wordCount: 4, isInterim: true, deepgramIsFinal: false, deepgramSpeechFinal: false });
    l.emit('TRANSCRIPT_FINAL', { transcript: 'How would you handle large volume records in Boomi?', transcriptLength: 51, wordCount: 9, isInterim: false, deepgramIsFinal: true, deepgramSpeechFinal: true });
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const interim = JSON.parse(lines.find(lx => lx.includes('"eventType":"TRANSCRIPT_INTERIM"')));
    const fin = JSON.parse(lines.find(lx => lx.includes('"eventType":"TRANSCRIPT_FINAL"')));
    assert.strictEqual(interim.transcript, 'How would you handle');
    assert.strictEqual(interim.isInterim, true);
    assert.strictEqual(interim.deepgramIsFinal, false);
    assert.strictEqual(interim.deepgramSpeechFinal, false);
    assert.strictEqual(fin.transcript, 'How would you handle large volume records in Boomi?');
    assert.strictEqual(fin.wordCount, 9);
    assert.strictEqual(fin.deepgramIsFinal, true);
    assert.strictEqual(fin.deepgramSpeechFinal, true);
  });

  console.log('\n== 7. State transition logging ==');

  await checkAsync('QUESTION_STATE_CHANGED includes from/to/reason', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('QUESTION_STATE_CHANGED', { from: 'SPEECH_ACTIVE', to: 'QUESTION_BUILDING', reason: 'new_meaningful_transcript' });
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const ev = JSON.parse(lines.find(lx => lx.includes('"eventType":"QUESTION_STATE_CHANGED"')));
    assert.strictEqual(ev.from, 'SPEECH_ACTIVE');
    assert.strictEqual(ev.to, 'QUESTION_BUILDING');
    assert.strictEqual(ev.reason, 'new_meaningful_transcript');
  });

  console.log('\n== 8. Boundary decision logging ==');

  await checkAsync('BOUNDARY_DECISION records all decision signals', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('BOUNDARY_DECISION', {
      decision: 'FINALIZE', pauseDurationMs: 1004, transcript: 'How would you handle large volume records in Boomi?',
      questionMark: true, wordCount: 9, questionType: 'technical', incomplete: false, score: 0.92, reason: 'semantically_complete'
    });
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const ev = JSON.parse(lines.find(lx => lx.includes('"eventType":"BOUNDARY_DECISION"')));
    assert.strictEqual(ev.decision, 'FINALIZE');
    assert.strictEqual(ev.pauseDurationMs, 1004);
    assert.strictEqual(ev.questionMark, true);
    assert.strictEqual(ev.score, 0.92);
    assert.strictEqual(ev.reason, 'semantically_complete');
  });

  console.log('\n== 9. Snapshot logging ==');

  await checkAsync('QUESTION_SNAPSHOT_CREATED carries full safe metadata', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('QUESTION_SNAPSHOT_CREATED', {
      snapshotNo: 3, turnId: 'turn_002', previousTurnId: 'turn_001', transcript: 'What is an Atom?',
      timestamp: 1752500000000, questionState: 'QUESTION_COMPLETE', isInterim: false, isFinal: true,
      speechFinal: true, decision: 'finalize', score: 80, type: 'conceptual', semanticClass: 'MAJOR', words: 4
    });
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const ev = JSON.parse(lines.find(lx => lx.includes('"eventType":"QUESTION_SNAPSHOT_CREATED"')));
    assert.strictEqual(ev.snapshotNo, 3);
    assert.strictEqual(ev.turnId, 'turn_002');
    assert.strictEqual(ev.previousTurnId, 'turn_001');
    assert.strictEqual(ev.type, 'conceptual');
    assert.strictEqual(ev.speechFinal, true);
    assert.strictEqual(ev.semanticClass, 'MAJOR');
  });

  console.log('\n== 10. Turn archival logging ==');

  await checkAsync('TURN_ARCHIVED includes archived + new turn ids', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('TURN_ARCHIVED', { archivedTurnId: 'turn_001', newTurnId: 'turn_002', snapshotNo: 2 });
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const ev = JSON.parse(lines.find(lx => lx.includes('"eventType":"TURN_ARCHIVED"')));
    assert.strictEqual(ev.archivedTurnId, 'turn_001');
    assert.strictEqual(ev.newTurnId, 'turn_002');
    assert.strictEqual(ev.snapshotNo, 2);
  });

  console.log('\n== 11. Follow-up logging ==');

  await checkAsync('FOLLOWUP_DETECTED includes context + reason', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('FOLLOWUP_DETECTED', { transcript: 'Why?', previousTurnId: 'turn_001', currentTurnId: 'turn_002', hasContext: true, reason: 'short_followup_utterance' });
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const ev = JSON.parse(lines.find(lx => lx.includes('"eventType":"FOLLOWUP_DETECTED"')));
    assert.strictEqual(ev.transcript, 'Why?');
    assert.strictEqual(ev.hasContext, true);
    assert.strictEqual(ev.reason, 'short_followup_utterance');
  });

  console.log('\n== 12. Clear / Pause / Resume logging ==');

  await checkAsync('CLEAR / PAUSE / RESUME events are recorded', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('CLEAR', { currentTurnId: 'turn_001', currentQuestionState: 'QUESTION_BUILDING', snapshotExisted: true, snapshotNo: 1 });
    l.emit('PAUSE', { currentTurnId: 'turn_001', questionState: 'QUESTION_BUILDING' });
    l.emit('RESUME', { currentTurnId: 'turn_001', questionState: 'LISTENING' });
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const all = lines.map(JSON.parse);
    assert.ok(all.some(e => e.eventType === 'CLEAR' && e.snapshotExisted === true), 'CLEAR logged');
    assert.ok(all.some(e => e.eventType === 'PAUSE'), 'PAUSE logged');
    assert.ok(all.some(e => e.eventType === 'RESUME'), 'RESUME logged');
  });

  console.log('\n== 13. No secret leakage ==');

  await checkAsync('secret-keyed fields are never written to disk', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('WARNING', {
      apiKey: 'sk-super-secret-12345',
      authorization: 'Bearer abc.def.ghi',
      DEEPGRAM_API_KEY: 'dg_secret',
      token: 'tok_xyz',
      msg: 'safe text'
    });
    l.emit('WARNING', { nested: { client_secret: 'nested-secret', api_key: 'nested-key', ok: 1 } });
    l.emit('WARNING', { list: [{ password: 'pw', value: 42 }] });
    await l.flush();
    const raw = await fs.promises.readFile(l.jsonlPath, 'utf8');
    const text = raw.toLowerCase();
    assert.ok(!text.includes('super-secret'), 'apiKey value leaked');
    assert.ok(!text.includes('abc.def.ghi'), 'authorization value leaked');
    assert.ok(!text.includes('dg_secret'), 'deepgram key leaked');
    assert.ok(!text.includes('tok_xyz'), 'token leaked');
    assert.ok(!text.includes('nested-secret'), 'nested secret leaked');
    assert.ok(!text.includes('nested-key'), 'nested api key leaked');
    assert.ok(!text.includes('"password"'), 'password key present');
    assert.ok(text.includes('safe text'), 'safe content still present');
    assert.ok(text.includes('42'), 'non-secret values preserved');
  });

  console.log('\n== 14. Bounded log behavior ==');

  await checkAsync('session rotates to part files past maxBytes', async () => {
    const dir = makeDir();
    const l = makeLogger(dir, { maxBytes: 600, flushMs: 1 });
    l.start();
    // flush in batches so rotation can kick in mid-session
    for (let i = 0; i < 40; i++) {
      l.emit('TRANSCRIPT_INTERIM', { transcript: 'repeated diagnostic payload ' + i + ' '.repeat(80) });
      await l.flush();
    }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') || /\.jsonl\.\d+$/.test(f));
    assert.ok(files.length >= 2, 'expected rotation, got files: ' + JSON.stringify(files));
    for (const f of files) {
      const size = fs.statSync(path.join(dir, f)).size;
      assert.ok(size <= 1600, 'file stays bounded (max 600 + one batch), size=' + size);
    }
  });

  console.log('\n== SESSION_SUMMARY ==');

  await checkAsync('end() writes SESSION_ENDED + SESSION_SUMMARY with stats', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('TURN_STARTED', { turnId: 'turn_001' });
    l.emit('TURN_STARTED', { turnId: 'turn_002' });
    l.emit('QUESTION_SNAPSHOT_CREATED', { snapshotNo: 1, turnId: 'turn_001' });
    l.emit('FOLLOWUP_DETECTED', { transcript: 'Why?', hasContext: true });
    l.emit('BOUNDARY_DECISION', { decision: 'FINALIZE', reason: 'x' });
    l.emit('BOUNDARY_DECISION', { decision: 'WAIT_FOR_MORE', reason: 'y' });
    l.emit('ERROR', { error: 'boom' });
    l.emit('WARNING', { msg: 'warn' });
    l.end();
    const lines = await readLines(l.jsonlPath);
    const all = lines.map(JSON.parse);
    assert.ok(all.some(e => e.eventType === 'SESSION_ENDED'), 'SESSION_ENDED present');
    const sum = all.find(e => e.eventType === 'SESSION_SUMMARY');
    assert.ok(sum, 'SESSION_SUMMARY present');
    assert.strictEqual(sum.turns, 2);
    assert.strictEqual(sum.snapshots, 1);
    assert.strictEqual(sum.followUps, 1);
    assert.strictEqual(sum.boundaryDecisions, 2);
    assert.strictEqual(sum.finalizeCount, 1);
    assert.strictEqual(sum.waitForMoreCount, 1);
    assert.strictEqual(sum.errors, 1);
    assert.strictEqual(sum.warnings, 1);
    assert.ok(sum.sessionDurationMs > 0);
  });

  await checkAsync('end() is idempotent and appends exactly one summary', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('WARNING', { msg: 'w' });
    l.end();
    l.end(); // second call must be a no-op
    const lines = await readLines(l.jsonlPath);
    const all = lines.map(JSON.parse);
    assert.strictEqual(all.filter(e => e.eventType === 'SESSION_SUMMARY').length, 1);
  });

  console.log('\n== PERFORMANCE timeline ==');

  await checkAsync('perfMark derives latency metrics on snapshot', async () => {
    const dir = makeDir();
    let clock = 0;
    const l = new DiagnosticLogger({ dir, nowWall: () => 1752500000000, nowMonotonic: () => clock, flushMs: 10 });
    l.start(); // startMonotonic = 0
    clock = 1000; l.perfMark('firstAudio', 'turn_001');
    clock = 2000; l.perfMark('firstInterim', 'turn_001');
    clock = 3000; l.perfMark('candidate', 'turn_001');
    clock = 4000; l.perfMark('boundary', 'turn_001');
    clock = 5000; l.perfMark('snapshot', 'turn_001');
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const all = lines.map(JSON.parse).filter(e => e.eventType === 'PERFORMANCE_MARK');
    const derived = all.find(e => e.firstTranscriptToSnapshotMs != null);
    assert.ok(derived, 'derived PERFORMANCE_MARK present');
    assert.strictEqual(derived.turnId, 'turn_001');
    assert.strictEqual(derived.transcriptFirstMs, 2000); // first meaningful interim
    assert.strictEqual(derived.candidateMs, 3000);
    assert.strictEqual(derived.boundaryMs, 4000);
    assert.strictEqual(derived.snapshotMs, 5000);
    assert.strictEqual(derived.firstTranscriptToBoundaryMs, 2000);
    assert.strictEqual(derived.candidateToBoundaryMs, 1000);
    assert.strictEqual(derived.firstTranscriptToSnapshotMs, 3000);
  });

  console.log('\n== Minimal (non-verbose) mode ==');

  await checkAsync('verbose=false writes only high-level events', async () => {
    const dir = makeDir();
    const l = makeLogger(dir, { verbose: false });
    l.start();
    l.emit('TRANSCRIPT_INTERIM', { transcript: 'should not appear' });
    l.emit('ERROR', { error: 'real problem' });
    l.emit('BOUNDARY_DECISION', { decision: 'FINALIZE' });
    l.end();
    const lines = await readLines(l.jsonlPath);
    const all = lines.map(JSON.parse);
    assert.ok(all.some(e => e.eventType === 'ERROR'), 'ERROR still logged');
    assert.ok(all.some(e => e.eventType === 'SESSION_STARTED'), 'SESSION_STARTED logged');
    assert.ok(all.some(e => e.eventType === 'SESSION_SUMMARY'), 'SESSION_SUMMARY logged');
    assert.ok(!all.some(e => e.eventType === 'TRANSCRIPT_INTERIM'), 'transcripts suppressed');
    assert.ok(!all.some(e => e.eventType === 'BOUNDARY_DECISION'), 'boundary decisions suppressed');
  });

  console.log('\n== STEP 9 — Pilot privacy mode ==');

  await checkAsync('privacy=pilot strips transcript/content keys but keeps metrics', async () => {
    const dir = makeDir();
    const l = makeLogger(dir, { privacy: 'pilot' });
    l.start();
    l.emit('TRANSCRIPT_INTERIM', { transcript: 'my spoken words', elapsedMs: 12 });
    l.emit('QUESTION_SNAPSHOT_CREATED', { turnId: 'turn_001', transcript: 'snapshot words', candidate: 'cand', confidence: 'yellow' });
    l.emit('BOUNDARY_DECISION', { decision: 'FINALIZE', transcript: 'should vanish', reason: 'pause' });
    l.emit('PROVIDER_FALLBACK', { provider: 'gemini', reason: 'rate', latencyMs: 400 });
    l.emit('ANSWER_DELIVERED', { turnId: 'turn_001', source: 'cloud', latencyMs: 800 });
    l.emit('ERROR', { error: 'boom', context: 'final_answer' });
    l.end();
    const lines = await readLines(l.jsonlPath);
    const all = lines.map(JSON.parse);
    assert.ok(all.some(e => e.eventType === 'TRANSCRIPT_INTERIM'), 'transcript event retained as an event');
    const interim = all.find(e => e.eventType === 'TRANSCRIPT_INTERIM');
    assert.ok(!('transcript' in interim), 'transcript key stripped in pilot mode');
    const snap = all.find(e => e.eventType === 'QUESTION_SNAPSHOT_CREATED');
    assert.ok(!('transcript' in snap) && !('candidate' in snap), 'content keys stripped');
    assert.strictEqual(snap.confidence, 'yellow', 'metrics preserved');
    assert.strictEqual(snap.turnId, 'turn_001', 'turn context preserved');
    const fallback = all.find(e => e.eventType === 'PROVIDER_FALLBACK');
    assert.strictEqual(fallback.provider, 'gemini', 'provider metric preserved');
    const delivered = all.find(e => e.eventType === 'ANSWER_DELIVERED');
    assert.strictEqual(delivered.source, 'cloud', 'source metric preserved');
    const sum = all.find(e => e.eventType === 'SESSION_SUMMARY');
    assert.ok(sum, 'SESSION_SUMMARY present');
    assert.strictEqual(sum.cloudAnswers, 1, 'cloud answer counted');
    assert.strictEqual(sum.providerFallbacks, 1, 'provider fallback counted');
    assert.ok(sum.answerLatencyP50Ms >= 0, 'answer latency percentile present');
    const started = all.find(e => e.eventType === 'SESSION_STARTED');
    assert.strictEqual(started.privacy, 'pilot', 'privacy flag surfaced');
    assert.strictEqual(started.transcriptLoggingEnabled, false, 'transcript logging disabled flag');
  });

  await checkAsync('privacy=debug (default) keeps transcript content', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('TRANSCRIPT_INTERIM', { transcript: 'my spoken words' });
    l.end();
    const all = (await readLines(l.jsonlPath)).map(JSON.parse);
    const interim = all.find(e => e.eventType === 'TRANSCRIPT_INTERIM');
    assert.strictEqual(interim.transcript, 'my spoken words', 'content retained in debug mode');
    const started = all.find(e => e.eventType === 'SESSION_STARTED');
    assert.strictEqual(started.privacy, 'debug');
    assert.strictEqual(started.transcriptLoggingEnabled, true);
  });

  await checkAsync('SESSION_SUMMARY aggregates source breakdown for a mixed session', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    l.emit('TURN_STARTED', { turnId: 'turn_001' });
    l.emit('ANSWER_DELIVERED', { turnId: 'turn_001', source: 'local-scenario-bank' });
    l.emit('TURN_STARTED', { turnId: 'turn_002' });
    l.emit('ANSWER_DELIVERED', { turnId: 'turn_002', source: 'cloud' });
    l.emit('TURN_STARTED', { turnId: 'turn_003' });
    l.emit('ANSWER_DELIVERED', { turnId: 'turn_003', source: 'emergency' });
    l.emit('TURN_STARTED', { turnId: 'turn_004' });
    l.emit('ANSWER_DELIVERED', { turnId: 'turn_004', source: 'rag-only-fallback' });
    l.emit('PROVIDER_FALLBACK', { provider: 'gemini' });
    l.end();
    const sum = (await readLines(l.jsonlPath)).map(JSON.parse).find(e => e.eventType === 'SESSION_SUMMARY');
    assert.strictEqual(sum.turns, 4);
    assert.strictEqual(sum.localScenarioHits, 2, 'local + rag-only counted as local hits');
    assert.strictEqual(sum.cloudAnswers, 1);
    assert.strictEqual(sum.emergencyFallbacks, 1);
    assert.strictEqual(sum.providerFallbacks, 1);
    assert.ok(typeof sum.answerLatencyP50Ms === 'number' && sum.answerLatencyP50Ms >= 0, 'answer latency percentile is a non-negative number');
  });

  console.log('\n== Engine -> logger integration (real pipeline scenario) ==');

  await checkAsync('engine emits full diag timeline for a pause-then-complete question', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = new InterviewEngine({
      log: () => {},
      diag: makeDiag(l),
      timeoutFn: timer.setTimeout.bind(timer),
      clearTimeoutFn: timer.clearTimeout.bind(timer),
      nowFn: () => timer.getNow(),
      fastPathCall: mocks.fastPathCall,
      answerCall: mocks.answerCall
    });
    engine.start();

    // TEST 2 shape: "How would you handle..." pause ~1s "...large volume records in Boomi?"
    engine.processTranscript('How would you handle', false);       // turn_001 begins, incomplete
    timer.advance(500);                                            // possible pause (~400ms checkpoint)
    engine.processTranscript('How would you handle large volume records in Boomi', false); // completes
    // step the watchdog so the 400 / 700 / 1000ms checkpoints each fire
    timer.advance(400);                                            // possible -> PAUSE_STARTED
    timer.advance(300);                                            // likely  -> BOUNDARY_CANDIDATE
    timer.advance(300);                                            // boundary-> BOUNDARY_DECISION
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('Use batching and parallel processing.');
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"volume","type":"scenario","direction":"d","hint":"h"}');
    await flush();

    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const all = lines.map(JSON.parse);
    const types = all.map(e => e.eventType);

    assert.ok(types.includes('TRANSCRIPT_INTERIM'), 'transcript event present');
    assert.ok(types.includes('SEMANTIC_CHANGE'), 'semantic change present');
    assert.ok(types.includes('PAUSE_STARTED'), 'pause started present');
    assert.ok(types.includes('PAUSE_ENDED'), 'pause ended present');
    assert.ok(types.includes('BOUNDARY_CANDIDATE'), 'boundary candidate present');
    assert.ok(types.includes('BOUNDARY_DECISION'), 'boundary decision present');
    assert.ok(types.includes('QUESTION_SNAPSHOT_CREATED'), 'snapshot present');
    assert.ok(types.includes('TURN_STARTED'), 'turn started present');
    assert.ok(types.includes('QUESTION_STATE_CHANGED'), 'state change present');
    assert.ok(types.includes('PERFORMANCE_MARK'), 'performance mark present');

    const decision = all.find(e => e.eventType === 'BOUNDARY_DECISION');
    assert.ok(decision, 'boundary decision exists');
    assert.strictEqual(decision.transcript, 'How would you handle large volume records in Boomi');
    const snap = all.find(e => e.eventType === 'QUESTION_SNAPSHOT_CREATED');
    assert.ok(snap.turnId === 'turn_001', 'snapshot bound to turn_001');

    // every engine event carries session/event/turn context
    for (const e of all) {
      assert.ok(e.sessionId && e.eventId && typeof e.elapsedMs === 'number', 'common fields');
    }
  });

  await checkAsync('follow-up "Why?" emits FOLLOWUP_DETECTED with turn relationship', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = new InterviewEngine({
      log: () => {},
      diag: makeDiag(l),
      timeoutFn: timer.setTimeout.bind(timer),
      clearTimeoutFn: timer.clearTimeout.bind(timer),
      nowFn: () => timer.getNow(),
      fastPathCall: mocks.fastPathCall,
      answerCall: mocks.answerCall
    });
    engine.start();
    engine.processTranscript('How do you handle errors', false);
    timer.advance(1100);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('I use try/catch.');
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"errors","type":"troubleshooting","direction":"d","hint":"h"}');
    await flush();
    engine.processTranscript('Why?', true);
    timer.advance(1100);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('Because isolation limits blast radius.');
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"why","type":"followup","direction":"d","hint":"h"}');
    await flush();
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const all = lines.map(JSON.parse);
    const fu = all.find(e => e.eventType === 'FOLLOWUP_DETECTED');
    assert.ok(fu, 'FOLLOWUP_DETECTED present');
    assert.strictEqual(fu.transcript, 'Why?');
    assert.strictEqual(fu.previousTurnId, 'turn_001');
    assert.strictEqual(fu.currentTurnId, 'turn_002');
    assert.ok(all.some(e => e.eventType === 'TURN_ARCHIVED' && e.archivedTurnId === 'turn_001' && e.newTurnId === 'turn_002'), 'turn archival relationship');
  });

  await checkAsync('clear/pause/resume from engine surface CLEAR/PAUSE/RESUME events', async () => {
    const dir = makeDir();
    const l = makeLogger(dir);
    l.start();
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = new InterviewEngine({
      log: () => {},
      diag: makeDiag(l),
      timeoutFn: timer.setTimeout.bind(timer),
      clearTimeoutFn: timer.clearTimeout.bind(timer),
      nowFn: () => timer.getNow(),
      fastPathCall: mocks.fastPathCall,
      answerCall: mocks.answerCall
    });
    engine.start();
    engine.processTranscript('What is Boomi', false);
    timer.advance(1100);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('answer');
    await flush();
    engine.clear();
    engine.pause();
    engine.resume();
    await l.flush();
    const lines = await readLines(l.jsonlPath);
    const all = lines.map(JSON.parse);
    assert.ok(all.some(e => e.eventType === 'CLEAR' && e.snapshotExisted === true), 'CLEAR with snapshot context');
    assert.ok(all.some(e => e.eventType === 'PAUSE'), 'PAUSE');
    assert.ok(all.some(e => e.eventType === 'RESUME'), 'RESUME');
  });

  console.log('\n------------------------------------------');
  console.log(`PASSED: ${passed}  FAILED: ${failed}`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' - ' + f.name + ': ' + (f.err && f.err.stack || f.err)));
    process.exit(1);
  }
  console.log('ALL DIAGNOSTIC TESTS PASSED');
}

main().catch(err => {
  console.error('Harness crashed:', err);
  process.exit(1);
});