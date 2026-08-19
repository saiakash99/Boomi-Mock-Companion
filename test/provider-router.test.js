'use strict';

// ============================================================
// Boomi Companion — ProviderRouter test harness (Node, no DOM)
// Run: node test/provider-router.test.js
//
// Uses injected fetch + fake timers + fake clock so every routing /
// failover / circuit-breaker / TTFT / timeout path is deterministic.
// Fallback chain is STRICTLY groq -> openrouter -> cerebras (Gemini removed).
// ============================================================

const assert = require('assert');
const { ProviderRouter, classifyError, extractStatus, ERROR_CLASS, BREAKER_STATE, DEFAULT_ROUTER_CFG } = require('../provider-router.js');

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
const enc = new TextEncoder();

// Interleave microtask flushes with small fake-timer advances so a
// fallback provider whose SSE plan timers get registered only after a
// microtask round-trip still receives its chunks.
async function settle(timer, rounds = 6, stepMs = 10) {
  for (let i = 0; i < rounds; i++) {
    await flush();
    timer.advance(stepMs);
  }
  await flush();
}

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
        if (++guard > 2000) throw new Error('fake timer runaway');
      }
    },
    setTimeout(fn, ms) { const id = ++idSeq; queue.push({ at: now + (ms || 0), id, fn }); return id; },
    clearTimeout(id) { const i = queue.findIndex(t => t.id === id); if (i >= 0) queue.splice(i, 1); },
    pending() { return queue.length; }
  };
}

function abortErr() {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'AbortError';
  return e;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Streaming SSE response whose chunks arrive on the FAKE timer. Honors the
// AbortController signal so a TTFT/total abort surfaces as an AbortError to
// the stream reader (exactly like a real network abort). A closed guard
// prevents late plan steps from writing after abort/close.
function sseResponse(timer, signal, plan) {
  let closed = false;
  return new Response(new ReadableStream({
    start(controller) {
      if (signal) {
        if (signal.aborted) { closed = true; controller.error(abortErr()); return; }
        signal.addEventListener('abort', () => { if (!closed) { closed = true; controller.error(abortErr()); } });
      }
      for (const step of plan) {
        timer.setTimeout(() => {
          if (closed) return;
          if (step.type === 'chunk') {
            controller.enqueue(enc.encode('data: ' + JSON.stringify(step.payload) + '\n\n'));
          } else {
            closed = true;
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          }
        }, step.at);
      }
    }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function groqChunk(delta) { return { choices: [{ delta: { content: delta } }] }; }

// OpenRouter/Cerebras stream in the OpenAI-compatible SSE shape, so the
// fallback "ok" response reuses the same chunk envelope as Groq.
function chatOk(timer, signal, text) {
  return sseResponse(timer, signal, [{ at: 0, type: 'chunk', payload: groqChunk(text) }, { at: 1, type: 'done' }]);
}

function makeRouter(timer, fetchImpl, opts) {
  const base = {
    fetch: fetchImpl,
    now: () => timer.getNow(),
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
    providers: {
      groq: { apiKey: () => 'grok-key' },
      openrouter: { apiKey: () => 'or-key' },
      cerebras: { apiKey: () => 'cb-key' }
    }
  };
  return new ProviderRouter(Object.assign(base, opts || {}));
}

const MSGS = [{ role: 'user', content: 'What is a Process Property in Boomi?' }];

(async () => {

// ------------------------------------------------------------
console.log('\n== Error classification ==');

check('classifyError maps HTTP statuses', () => {
  assert.strictEqual(extractStatus(new Error('Groq API 429 Rate Limited')), 429);
  assert.strictEqual(classifyError(new Error('Groq API 429 Rate Limited')), ERROR_CLASS.TRANSIENT);
  assert.strictEqual(classifyError(new Error('Groq API 500 Internal')), ERROR_CLASS.TRANSIENT);
  assert.strictEqual(classifyError(new Error('Groq API 401 Unauthorized')), ERROR_CLASS.AUTH);
  assert.strictEqual(classifyError(new Error('OpenRouter API 403 Forbidden')), ERROR_CLASS.AUTH);
  assert.strictEqual(classifyError(new Error('Cerebras API 402 Payment Required')), ERROR_CLASS.AUTH);
  assert.strictEqual(classifyError(new Error('Cerebras API 400 Bad Request')), ERROR_CLASS.BAD_REQUEST);
  assert.strictEqual(classifyError(new Error('Groq API 502 Bad Gateway')), ERROR_CLASS.TRANSIENT);
});

check('classifyError maps AbortError and network errors to TRANSIENT', () => {
  const ab = new Error('aborted'); ab.name = 'AbortError';
  assert.strictEqual(classifyError(ab), ERROR_CLASS.TRANSIENT);
  assert.strictEqual(classifyError(new Error('Failed to fetch')), ERROR_CLASS.TRANSIENT);
  assert.strictEqual(classifyError(new Error('timeout of 500ms exceeded')), ERROR_CLASS.TRANSIENT);
  assert.strictEqual(classifyError(new Error('getaddrinfo ENOTFOUND api.groq.com')), ERROR_CLASS.TRANSIENT);
});

check('classifyError maps missing-key config errors to CONFIG', () => {
  assert.strictEqual(classifyError(new Error('Groq API key is missing')), ERROR_CLASS.CONFIG);
  assert.strictEqual(classifyError(new Error('API key not configured')), ERROR_CLASS.CONFIG);
});

// ------------------------------------------------------------
console.log('\n== Routing order & failover (groq -> openrouter -> cerebras) ==');

check('DEFAULT_ROUTER_CFG.order is strictly groq -> openrouter -> cerebras', () => {
  assert.deepStrictEqual(DEFAULT_ROUTER_CFG.order, ['groq', 'openrouter', 'cerebras']);
  assert.ok(!DEFAULT_ROUTER_CFG.order.includes('gemini'), 'Gemini must not be in the execution array');
});

await checkAsync('Groq success returns immediately (no fallback)', async () => {
  const timer = makeTimer();
  const router = makeRouter(timer, async (url) => {
    if (String(url).includes('groq.com')) return jsonResponse(200, { choices: [{ message: { content: 'ANSWER' } }] });
    throw new Error('openrouter should never be called');
  });
  const res = await router.request(MSGS);
  assert.strictEqual(res.provider, 'groq');
  assert.strictEqual(res.fallback, false);
  assert.strictEqual(res.text, 'ANSWER');
  assert.strictEqual(router.getBreakerState('groq'), BREAKER_STATE.HEALTHY);
});

await checkAsync('Groq 500 fails over to OpenRouter (fallback=true)', async () => {
  const timer = makeTimer();
  const router = makeRouter(timer, (url, init) => {
    if (String(url).includes('groq.com')) return jsonResponse(500, {});
    return chatOk(timer, init.signal, 'OPENROUTER_ANSWER');
  });
  const p = router.request(MSGS, { onChunk: () => {} });
  await settle(timer);
  const res = await p;
  assert.strictEqual(res.provider, 'openrouter');
  assert.strictEqual(res.fallback, true);
  assert.strictEqual(res.text, 'OPENROUTER_ANSWER');
  assert.strictEqual(router.getBreakerState('groq'), BREAKER_STATE.COOLDOWN, 'transient 5xx puts groq in cooldown');
});

await checkAsync('All providers failing rejects with attempts detail', async () => {
  const timer = makeTimer();
  const router = makeRouter(timer, async () => jsonResponse(503, {}));
  await assert.rejects(router.request(MSGS), (err) => {
    assert.strictEqual(err.errorClass, ERROR_CLASS.TRANSIENT);
    assert.strictEqual(err.providerAttempts.length, 3);
    assert.strictEqual(err.providerAttempts[0].provider, 'groq');
    assert.strictEqual(err.providerAttempts[0].status, 503);
    assert.strictEqual(err.providerAttempts[1].provider, 'openrouter');
    assert.strictEqual(err.providerAttempts[1].status, 503);
    assert.strictEqual(err.providerAttempts[2].provider, 'cerebras');
    return true;
  });
});

// ------------------------------------------------------------
console.log('\n== Circuit breaker ==');

await checkAsync('429 trips RATE_LIMITED and skips until the probe window', async () => {
  const timer = makeTimer();
  const router = makeRouter(timer, (url, init) => {
    if (String(url).includes('groq.com')) return jsonResponse(429, {});
    return chatOk(timer, init.signal, 'G');
  });
  const p1 = router.request(MSGS, { onChunk: () => {} });
  await settle(timer);
  await p1;
  assert.strictEqual(router.getBreakerState('groq'), BREAKER_STATE.RATE_LIMITED);
  assert.strictEqual(router.breakerSummary().groq.consecutiveFailures, 1);

  // still inside the cooldown window -> groq is skipped, openrouter serves
  timer.advance(5000);
  const p2 = router.request(MSGS, { onChunk: () => {} });
  await settle(timer);
  const res2 = await p2;
  assert.strictEqual(res2.provider, 'openrouter');
  assert.ok(res2.attempts.some(a => a.provider === 'groq' && a.skipped === 'cooldown'), 'groq skipped while rate-limited');
});

await checkAsync('half-open probe recovers a RATE_LIMITED provider to HEALTHY', async () => {
  const timer = makeTimer();
  let groqCalls = 0;
  const flaky = new ProviderRouter({
    fetch: (url, init) => {
      if (String(url).includes('groq.com')) {
        groqCalls++;
        return groqCalls === 1 ? jsonResponse(429, {}) : jsonResponse(200, { choices: [{ message: { content: 'BACK' } }] });
      }
      return chatOk(timer, init.signal, 'G');
    },
    now: () => timer.getNow(),
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
    providers: { groq: { apiKey: () => 'k' }, openrouter: { apiKey: () => 'k' } }
  });
  const p0 = flaky.request(MSGS, { onChunk: () => {} });
  await settle(timer);
  await p0;
  assert.strictEqual(flaky.getBreakerState('groq'), BREAKER_STATE.RATE_LIMITED);
  assert.ok(flaky.providers.groq.probeAfter >= DEFAULT_ROUTER_CFG.probeAfterMs, 'probe window scheduled after rate limit');

  // before the probe window -> skipped; after -> probed and recovers
  timer.advance(5000);
  const p1 = flaky.request(MSGS, { onChunk: () => {} });
  await settle(timer);
  const r1 = await p1;
  assert.strictEqual(r1.provider, 'openrouter');
  assert.ok(r1.attempts.some(a => a.provider === 'groq' && a.skipped === 'cooldown'));

  timer.advance(20000); // now = 25s > probeAfter 15s -> half-open probe allowed
  const p2 = flaky.request(MSGS, { onChunk: () => {} });
  await settle(timer);
  const r2 = await p2;
  assert.strictEqual(r2.provider, 'groq', 'half-open probe retries groq');
  assert.strictEqual(flaky.getBreakerState('groq'), BREAKER_STATE.HEALTHY);
});

await checkAsync('auth/config failure marks OFFLINE and is never retried endlessly', async () => {
  const timer = makeTimer();
  let groqCalls = 0;
  const router = makeRouter(timer, (url, init) => {
    if (String(url).includes('groq.com')) { groqCalls++; return jsonResponse(401, {}); }
    return chatOk(timer, init.signal, 'G');
  });
  const p1 = router.request(MSGS, { onChunk: () => {} });
  await settle(timer);
  await p1;
  assert.strictEqual(router.getBreakerState('groq'), BREAKER_STATE.OFFLINE);
  assert.strictEqual(groqCalls, 1);

  // second + third requests never touch groq again
  const p2 = router.request(MSGS, { onChunk: () => {} });
  await settle(timer);
  await p2;
  const p3 = router.request(MSGS, { onChunk: () => {} });
  await settle(timer);
  await p3;
  assert.strictEqual(groqCalls, 1, 'offline provider is not retried');
  assert.strictEqual(router.breakerSummary().groq.requestCount, 1);
});

await checkAsync('missing API key skips the provider without marking it OFFLINE', async () => {
  const timer = makeTimer();
  const router = new ProviderRouter({
    fetch: (url, init) => chatOk(timer, init.signal, 'OR'),
    now: () => timer.getNow(),
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
    providers: { groq: { apiKey: () => '' }, openrouter: { apiKey: () => 'real' } }
  });
  const p = router.request(MSGS, { onChunk: () => {} });
  await settle(timer);
  const res = await p;
  assert.strictEqual(res.provider, 'openrouter');
  assert.ok(res.attempts.some(a => a.provider === 'groq' && a.skipped === 'missing_key'));
  assert.strictEqual(router.getBreakerState('groq'), BREAKER_STATE.HEALTHY, 'no key must not mark OFFLINE');
});

// ------------------------------------------------------------
console.log('\n== Groq Multi-Key Pooling (round-robin) ==');

await checkAsync('comma-separated apiKey closure round-robins the Authorization header', async () => {
  const timer = makeTimer();
  const auths = [];
  const router = makeRouter(timer, async (url, init) => {
    if (String(url).includes('groq.com')) {
      auths.push(init.headers.Authorization);
      return jsonResponse(200, { choices: [{ message: { content: 'OK' } }] });
    }
    throw new Error('openrouter should never be called');
  }, {
    providers: {
      groq: { apiKey: () => 'key-one,key-two,key-three' },
      openrouter: { apiKey: () => 'or-key' }
    }
  });
  await router.request(MSGS);
  await router.request(MSGS);
  await router.request(MSGS);
  assert.deepStrictEqual(auths, ['Bearer key-one', 'Bearer key-two', 'Bearer key-three']);
});

await checkAsync('process.env.GROQ_API_KEYS pool is used and rotated per request', async () => {
  const prev = process.env.GROQ_API_KEYS;
  process.env.GROQ_API_KEYS = 'env-one,env-two';
  try {
    const timer = makeTimer();
    const auths = [];
    const router = makeRouter(timer, async (url, init) => {
      if (String(url).includes('groq.com')) {
        auths.push(init.headers.Authorization);
        return jsonResponse(200, { choices: [{ message: { content: 'OK' } }] });
      }
      throw new Error('openrouter should never be called');
    });
    await router.request(MSGS);
    await router.request(MSGS);
    assert.deepStrictEqual(auths, ['Bearer env-one', 'Bearer env-two']);
  } finally {
    if (prev === undefined) delete process.env.GROQ_API_KEYS;
    else process.env.GROQ_API_KEYS = prev;
  }
});

await checkAsync('empty Groq pool still skips groq as missing_key', async () => {
  const timer = makeTimer();
  const router = new ProviderRouter({
    fetch: (url, init) => jsonResponse(200, { choices: [{ message: { content: 'G' } }] }),
    now: () => timer.getNow(),
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
    providers: { groq: { apiKey: () => '' }, openrouter: { apiKey: () => 'real' } }
  });
  const res = await router.request(MSGS);
  assert.strictEqual(res.provider, 'openrouter');
  assert.ok(res.attempts.some(a => a.provider === 'groq' && a.skipped === 'missing_key'));
});

await checkAsync('openrouter serves after groq, and round-robins its key pool', async () => {
  const timer = makeTimer();
  const calls = [];
  const router = new ProviderRouter({
    fetch: async (url, init) => {
      calls.push({ url: String(url), auth: init.headers.Authorization });
      return jsonResponse(200, { choices: [{ message: { content: 'OK' } }] });
    },
    now: () => timer.getNow(),
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
    providers: {
      groq: { apiKey: () => '' },
      openrouter: { apiKey: () => 'or-one,or-two' },
      cerebras: { apiKey: () => 'cb-one' }
    }
  });
  let res = await router.request(MSGS);
  assert.strictEqual(res.provider, 'openrouter');
  assert.ok(res.attempts.some(a => a.provider === 'groq' && a.skipped === 'missing_key'));
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes('openrouter.ai'));
  assert.strictEqual(calls[0].auth, 'Bearer or-one');

  res = await router.request(MSGS);
  assert.strictEqual(res.provider, 'openrouter');
  assert.strictEqual(calls[1].auth, 'Bearer or-two', 'round-robins within the pool');

  res = await router.request(MSGS);
  assert.strictEqual(calls[2].auth, 'Bearer or-one', 'wraps back to the first key');
});

await checkAsync('cerebras serves when groq + openrouter are missing keys', async () => {
  const timer = makeTimer();
  const urls = [];
  const router = new ProviderRouter({
    fetch: async (url, init) => { urls.push(String(url)); return jsonResponse(200, { choices: [{ message: { content: 'OK' } }] }); },
    now: () => timer.getNow(),
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
    providers: {
      groq: { apiKey: () => '' },
      openrouter: { apiKey: () => '' },
      cerebras: { apiKey: () => 'cb-one' }
    }
  });
  const res = await router.request(MSGS);
  assert.strictEqual(res.provider, 'cerebras');
  assert.ok(urls[0].includes('api.cerebras.ai'));
  assert.strictEqual(res.attempts.filter(a => a.skipped === 'missing_key').length, 2);
});

// ------------------------------------------------------------
console.log('\n== TTFT + total timeouts (streaming) ==');

await checkAsync('first chunk before TTFT clears it; stream continues under total budget', async () => {
  const timer = makeTimer();
  const router = makeRouter(timer, (url, init) => {
    if (String(url).includes('groq.com')) return sseResponse(timer, init.signal, [
      { at: 200, type: 'chunk', payload: groqChunk('Hello') },
      { at: 300, type: 'chunk', payload: groqChunk(' world') },
      { at: 400, type: 'done' }
    ]);
    return chatOk(timer, init.signal, 'G');
  });
  const chunks = [];
  const p = router.request(MSGS, { onChunk: (t) => chunks.push(t) });
  timer.advance(200); await flush(); // first chunk lands at 200ms (inside TTFT budget)
  timer.advance(100); await flush(); // second chunk
  timer.advance(100); await flush(); // done -> close
  const res = await p;
  assert.strictEqual(res.provider, 'groq', 'TTFT satisfied -> no failover');
  assert.strictEqual(res.text, 'Hello world');
  assert.ok(res.ttftMs <= DEFAULT_ROUTER_CFG.ttftMs, 'ttftMs recorded on first chunk');
  assert.ok(chunks.length >= 2, 'stream chunks delivered after the first chunk');
});

await checkAsync('no first chunk before TTFT budget -> abort -> failover to OpenRouter', async () => {
  const timer = makeTimer();
  const router = makeRouter(timer, (url, init) => {
    if (String(url).includes('groq.com')) {
      // first chunk arrives AFTER the TTFT budget (budget-relative so a longer
      // ttftMs config still exercises the abort -> failover path)
      return sseResponse(timer, init.signal, [
        { at: DEFAULT_ROUTER_CFG.ttftMs + 200, type: 'chunk', payload: groqChunk('late') },
        { at: DEFAULT_ROUTER_CFG.ttftMs + 300, type: 'done' }
      ]);
    }
    return chatOk(timer, init.signal, 'OR');
  });
  const p = router.request(MSGS, { onChunk: () => {} });
  timer.advance(DEFAULT_ROUTER_CFG.ttftMs);  // TTFT timer fires -> abort
  await flush();
  timer.advance(200);  // let openrouter finish
  await flush();
  const res = await p;
  assert.strictEqual(res.provider, 'openrouter', 'TTFT miss fails over');
  assert.strictEqual(res.fallback, true);
  assert.strictEqual(router.getBreakerState('groq'), BREAKER_STATE.COOLDOWN);
});

await checkAsync('stream exceeding streamingTotalMs aborts mid-stream', async () => {
  const timer = makeTimer();
  const router = makeRouter(timer, (url, init) => {
    if (String(url).includes('groq.com')) {
      return sseResponse(timer, init.signal, [
        { at: 100, type: 'chunk', payload: groqChunk('first') },
        { at: DEFAULT_ROUTER_CFG.streamingTotalMs + 100, type: 'chunk', payload: groqChunk('too late') }
      ]);
    }
    return chatOk(timer, init.signal, 'FALLBACK');
  });
  const p = router.request(MSGS, { onChunk: () => {} });
  timer.advance(300); await flush(); // first chunk landed -> TTFT cleared, stream continues
  timer.advance(DEFAULT_ROUTER_CFG.streamingTotalMs); // total budget expires -> abort
  await flush();
  timer.advance(100); await flush();
  const res = await p;
  assert.strictEqual(res.provider, 'openrouter', 'stalled stream fails over');
  assert.strictEqual(res.text, 'FALLBACK');
});

await checkAsync('JSON (fast/grader) call respects jsonTotalMs', async () => {
  const timer = makeTimer();
  const router = makeRouter(timer, (url, init) => {
    if (String(url).includes('groq.com')) {
      return new Promise((resolve, reject) => {
        if (init.signal.aborted) return reject(abortErr());
        init.signal.addEventListener('abort', () => reject(abortErr()));
      });
    }
    return jsonResponse(200, { choices: [{ message: { content: '{"topic":"x"}' } }] });
  });
  const p = router.request(MSGS, { mode: true });
  timer.advance(DEFAULT_ROUTER_CFG.jsonTotalMs + 100);
  await flush();
  const res = await p;
  assert.strictEqual(res.provider, 'openrouter');
  assert.strictEqual(res.text, '{"topic":"x"}');
});

// ------------------------------------------------------------
console.log('\n== JSON (non-streaming) success path ==');

await checkAsync('fast JSON mode returns parsed content without streaming', async () => {
  const timer = makeTimer();
  const router = makeRouter(timer, async (url, init) => {
    if (String(url).includes('groq.com')) {
      const body = JSON.parse(init.body);
      assert.strictEqual(body.response_format.type, 'json_object', 'fast mode forces JSON response_format');
      assert.ok(body.model === 'openai/gpt-oss-20b', 'groq fast tier uses a stable model: ' + body.model);
      return jsonResponse(200, { choices: [{ message: { content: '{"topic":"process"}' } }] });
    }
    throw new Error('openrouter not expected');
  });
  const res = await router.request(MSGS, { mode: true });
  assert.strictEqual(res.provider, 'groq');
  assert.strictEqual(res.text, '{"topic":"process"}');
});

await checkAsync('groq answer tier uses a stable model (fixes 404)', async () => {
  const timer = makeTimer();
  const seen = [];
  const router = makeRouter(timer, async (url, init) => {
    if (String(url).includes('groq.com')) {
      seen.push(JSON.parse(init.body).model);
      return jsonResponse(200, { choices: [{ message: { content: 'ANSWER' } }] });
    }
    throw new Error('openrouter not expected');
  });
  await router.request(MSGS); // answer tier (mode not true)
  assert.deepStrictEqual(seen, ['openai/gpt-oss-120b'], 'answer tier uses openai/gpt-oss-120b');
});

await checkAsync('streaming flag only set when onChunk provided for answer mode', async () => {
  const timer = makeTimer();
  let streamed = false;
  const router = makeRouter(timer, async (url, init) => {
    streamed = (init.body && JSON.parse(init.body).stream === true);
    return jsonResponse(200, { choices: [{ message: { content: 'ANSWER' } }] });
  });
  await router.request(MSGS); // no onChunk -> non-streaming
  assert.strictEqual(streamed, false, 'no stream flag without onChunk');
});

console.log('\n== ProviderRouter tests complete ==');
console.log('------------------------------------------');
console.log(`PASSED: ${passed}  FAILED: ${failed}`);
if (failed) {
  for (const f of failures) console.log('  FAIL - ' + f.name + ': ' + (f.err && f.err.message));
  process.exit(1);
} else {
  console.log('ALL PROVIDER-ROUTER TESTS PASSED');
}

})().catch((err) => {
  console.error('FATAL:', err && err.stack || err);
  process.exit(1);
});
