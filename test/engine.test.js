'use strict';

// ============================================================
// Boomi Companion — Interview Engine test harness (Node, no DOM)
// Run: node test/engine.test.js
//
// Uses:
//  - fake timers (deterministic debounce/interval behavior)
//  - deferred promise mocks for the network calls
//  - assertion-based output
// ============================================================

const assert = require('assert');
const { InterviewEngine, STATES, DEFAULT_CFG, analyzeQuestion, classifyQuestionType, wordDelta, normalizeTranscript, parseJsonObject, toConfidence, classifySemanticChange, isShortFollowup } = require('../engine.js');

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

// ---------------- fake timer utilities ----------------

function makeTimer() {
  let now = 0;
  let idSeq = 0;
  const queue = [];
  return {
    getNow: () => now,
    advance(ms) {
      now += ms;
      // run due timers (a timer may schedule others)
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
    pending() {
      return queue.length;
    }
  };
}

// ---------------- deferred + mock network ----------------

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeMockCalls() {
  const calls = { fast: [], answer: [] };
  const pending = { fast: [], answer: [] };

  function recorder(list, pendingList) {
    return function (messages) {
      const d = deferred();
      const record = { messages, text: messages[messages.length - 1].content, deferred: d, resolved: false };
      list.push(record);
      pendingList.push(record);
      return d.promise;
    };
  }
  return {
    calls,
    fastPathCall: recorder(calls.fast, pending.fast),
    answerCall: recorder(calls.answer, pending.answer),
    pendingFastCount: () => pending.fast.length,
    pendingAnswerCount: () => pending.answer.length,
    resolveNextFast(content) { pending.fast.shift().deferred.resolve(content); },
    resolveNextAnswer(content) { pending.answer.shift().deferred.resolve(content); },
    rejectNextAnswer(err) { pending.answer.shift().deferred.reject(err); },
    fastCount: () => calls.fast.length,
    answerCount: () => calls.answer.length,
    lastAnswerText: () => {
      const rec = calls.answer[calls.answer.length - 1];
      return rec ? rec.text : '';
    }
  };
}

const flush = () => new Promise(r => setImmediate(r));

function makeEngine(timer, mocks, opts) {
  return new InterviewEngine(Object.assign({
    log: () => {},
    timeoutFn: timer.setTimeout.bind(timer),
    clearTimeoutFn: timer.clearTimeout.bind(timer),
    nowFn: () => timer.getNow(),
    fastPathCall: mocks.fastPathCall,
    answerCall: mocks.answerCall,
    // Phase 7 — isolate tests from the real knowledge/scenarios.json; only tests
    // that pass an explicit scenarioBank exercise the local interceptor.
    scenarioBank: []
  }, opts || {}));
}

async function main() {
  // ============================================================
  console.log('\n== Pure helpers ==');
  // ============================================================

  check('wordDelta counts only new words', () => {
    assert.strictEqual(wordDelta('how would you', 'how would you handle'), 1);
    assert.strictEqual(wordDelta('how would you', 'how would you'), 0);
  });

  check('classify incomplete trailing "handle"', () => {
    assert.strictEqual(classifyQuestionType('How would you handle', false).type, 'incomplete');
  });
  check('classify complete question with ?', () => {
    assert.strictEqual(classifyQuestionType('How would you handle a large volume in Boomi?', false).type, 'scenario');
  });
  check('classify comparison', () => {
    assert.strictEqual(classifyQuestionType("What's the difference between an Atom and a Molecule?", false).type, 'comparison');
  });
  check('classify experience', () => {
    assert.strictEqual(classifyQuestionType('Have you worked with Boomi error handling?', false).type, 'experience');
  });
  check('classify conceptual', () => {
    assert.strictEqual(classifyQuestionType('What is a Process Property in Boomi?', false).type, 'conceptual');
  });
  check('classify followup with context', () => {
    assert.strictEqual(classifyQuestionType('Why did you choose that approach?', true).type, 'followup');
  });

  check('analyzeQuestion scores a starter question', () => {
    const a = analyzeQuestion('How would you handle a large volume of records in Boomi?', {});
    assert.ok(a.isQuestion, 'should be a question');
    assert.ok(a.score >= 55, 'score should clear confirm threshold, got ' + a.score);
  });

  // ============================================================
  console.log('\n== Boot + states ==');
  // ============================================================

  await checkAsync('start() sets LISTENING', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    let state = null;
    engine.onState = s => { state = s; };
    engine.start();
    assert.strictEqual(engine.state, STATES.LISTENING);
    assert.strictEqual(state, STATES.LISTENING);
  });

  await checkAsync('incomplete question -> NEEDS_MORE_CONTEXT, no final answer', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    let finalRendered = 0;
    engine.onAnswer = ({ provisional }) => { if (!provisional) finalRendered++; };
    engine.start();
    engine.processTranscript('How would you', false);
    engine.processTranscript('How would you handle', false);
    engine.processTranscript('How would you handle a large number of records in', false);
    // let fast-path + draft timers fire
    timer.advance(10000);
    await flush();
    // resolve any pending network calls so nothing errors
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"volume","type":"incomplete","direction":"x","hint":"a -> b"}');
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('provisional text');
    await flush();
    // now a FINAL arrives but it is still incomplete
    engine.processTranscript('How would you handle', true);
    timer.advance(10000);
    await flush();
    assert.strictEqual(finalRendered, 0, 'incomplete question must never produce a final answer');
    assert.strictEqual(engine.state, STATES.NEEDS_MORE_CONTEXT);
  });

  // ============================================================
  console.log('\n== Fast Path gating (no per-interim spam) ==');
  // ============================================================

  await checkAsync('rapid interims produce only one fast-path call', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('Tell me about the', false);
    engine.processTranscript('Tell me about the project', false);
    engine.processTranscript('Tell me about the project you worked on', false);
    timer.advance(1000); // debounce window passes
    await flush();
    assert.strictEqual(mocks.fastCount(), 1, 'expected exactly 1 fast call after debounce, got ' + mocks.fastCount());
    timer.advance(30000);
    await flush();
    assert.strictEqual(mocks.fastCount(), 1, 'no more fast calls while interval not elapsed');
  });

  await checkAsync('duplicate interims cause zero additional calls', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    const t = 'How do you handle errors in Boomi?';
    engine.processTranscript(t, false);
    engine.processTranscript(t, false); // exact duplicate
    engine.processTranscript(t + ' ', false); // whitespace duplicate
    timer.advance(10000);
    await flush();
    // first (real) occurrence legitimately triggers fast + draft; duplicates must NOT add more
    assert.strictEqual(mocks.fastCount(), 1, 'duplicates must be ignored, expected 1 fast call');
    assert.strictEqual(mocks.answerCount(), 1, 'duplicates must be ignored, expected 1 draft call');
  });

  await checkAsync('short fragments (<2 words) are ignored', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('The', false);
    engine.processTranscript('How', false);
    timer.advance(10000);
    await flush();
    assert.strictEqual(mocks.fastCount(), 0);
  });

  // ============================================================
  console.log('\n== Background answer preparation (draft) ==');
  // ============================================================

  await checkAsync('draft prepared before final question completes', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    let provisional = 0;
    engine.onAnswer = ({ provisional: p }) => { if (p) provisional++; };
    engine.start();
    // interviewer keeps speaking, so the pause watchdog never hits the boundary —
    // the background draft still fires while they talk (draftDebounce 800ms).
    engine.processTranscript('Have you worked with Boomi error handling', false);           // t0
    timer.advance(700);
    engine.processTranscript('Have you worked with Boomi error handling in production', false); // t700
    timer.advance(700);
    engine.processTranscript('Have you worked with Boomi error handling in production and how', false); // t1400
    timer.advance(800);                                                                      // t2200 -> draft fires
    await flush();
    assert.strictEqual(mocks.answerCount(), 1, 'draft should fire before any boundary');
    mocks.resolveNextAnswer('I typically isolate failures using Try/Catch.');
    await flush();
    assert.strictEqual(provisional, 1, 'provisional draft rendered');
    assert.ok(engine.state === STATES.ANSWER_PREPARING || engine.state === STATES.QUESTION_BUILDING || engine.state === STATES.QUESTION_CANDIDATES_READY || engine.state === STATES.PAUSE_DETECTED || engine.state === STATES.QUESTION_BOUNDARY_LIKELY || engine.state === STATES.WAITING_FOR_MORE);
  });

  // ============================================================
  console.log('\n== Final answer + combined question ==');
  // ============================================================

  await checkAsync('final question produces final answer; combined question uses full text', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    let finalText = '';
    engine.onAnswer = ({ text, provisional }) => { if (!provisional) finalText = text; };
    engine.start();
    engine.processTranscript('Have you worked with queues', false);
    engine.processTranscript('Have you worked with queues, and how did you use them in your project', false);
    engine.processTranscript('Have you worked with queues, and how did you use them in your project?', true);
    timer.advance(1000); // finalConfirmMs 900 -> fires final
    await flush();
    // the pending draft is cancelled once a final is scheduled (no wasted API call)
    assert.strictEqual(mocks.answerCount(), 1, 'only the final answer call expected');
    mocks.resolveNextAnswer('final combined answer');
    await flush();
    assert.strictEqual(finalText, 'final combined answer');
    const promptText = mocks.lastAnswerText();
    assert.ok(promptText.includes('queues') && promptText.includes('project'), 'final prompt must use the combined question');
    assert.strictEqual(engine.state, STATES.READY);
    assert.strictEqual(engine.contextHistory.length, 1);
  });

  // ============================================================
  console.log('\n== Stale response protection ==');
  // ============================================================

  await checkAsync('old final cannot overwrite a newer question', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    const rendered = [];
    engine.onAnswer = ({ text, provisional }) => { rendered.push({ text, provisional }); };
    engine.start();

    // Question A final in flight
    engine.processTranscript('What is a Process Property?', true);
    timer.advance(1000);
    await flush();
    const aReq = mocks.calls.answer.find(r => !r.resolved);
    assert.ok(aReq, 'answer A should be in flight');

    // Question B starts while A is in flight
    engine.processTranscript('Explain your current project architecture.', false);
    engine.processTranscript('Explain your current project architecture?', true);
    timer.advance(1000);
    await flush();
    const bReq = mocks.calls.answer.find(r => !r.resolved && r !== aReq);
    assert.ok(bReq, 'answer B should be in flight');

    // B resolves first, then A resolves late
    bReq.deferred.resolve('answer B');
    await flush();
    aReq.deferred.resolve('answer A STALE');
    await flush();

    const lastNonProvisional = [...rendered].reverse().find(r => !r.provisional);
    assert.ok(lastNonProvisional, 'an answer should render');
    assert.strictEqual(lastNonProvisional.text, 'answer B', 'stale answer A must not overwrite B');
  });

  await checkAsync('old draft is dropped once a final supersedes it', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    let provisionalRendered = 0;
    engine.onAnswer = ({ provisional }) => { if (provisional) provisionalRendered++; };
    engine.start();

    engine.processTranscript('How do you handle errors in Boomi', false);
    timer.advance(1500);
    await flush();
    const draftReq = mocks.calls.answer.find(r => !r.resolved);
    assert.ok(draftReq, 'draft in flight');

    engine.processTranscript('How do you handle errors in Boomi?', true);
    timer.advance(1000);
    await flush();
    const finalReq = mocks.calls.answer.find(r => !r.resolved && r !== draftReq);
    assert.ok(finalReq, 'final in flight');

    finalReq.deferred.resolve('final answer');
    await flush();
    draftReq.deferred.resolve('stale draft answer');
    await flush();

    assert.strictEqual(provisionalRendered, 0, 'superseded draft must not render');
  });

  // ============================================================
  console.log('\n== Clear ==');
  // ============================================================

  await checkAsync('clear while request in flight -> nothing repopulates', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    const rendered = [];
    engine.onAnswer = ({ text, provisional }) => rendered.push({ text, provisional });
    engine.start();

    engine.processTranscript('What is an Atom in Boomi?', true);
    timer.advance(1000);
    await flush();
    const inFlight = mocks.calls.answer.find(r => !r.resolved);
    assert.ok(inFlight);

    engine.clear();
    assert.strictEqual(engine.questionBuffer, '');
    assert.strictEqual(engine.state, STATES.LISTENING);

    inFlight.deferred.resolve('late answer after clear');
    await flush();

    const nonProvisional = rendered.filter(r => !r.provisional && r.text !== '');
    assert.ok(nonProvisional.length === 0, 'stale answer must not appear after Clear');
  });

  await checkAsync('clear resets answer + hint + buffer', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    let lastHint = 'x';
    let lastAnswer = 'x';
    engine.onHint = h => { lastHint = h; };
    engine.onAnswer = ({ text }) => { lastAnswer = text; };
    engine.start();
    engine.processTranscript('What is Boomi?', false);
    timer.advance(1000);
    await flush();
    mocks.resolveNextFast('{"topic":"boomi","type":"conceptual","direction":"d","hint":"h1 -> h2"}');
    await flush();
    engine.clear();
    assert.strictEqual(lastHint, '');
    assert.strictEqual(lastAnswer, '');
  });

  // ============================================================
  console.log('\n== Pause / Resume ==');
  // ============================================================

  await checkAsync('paused: transcript ignored, no new calls; resume clean', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('How do you handle', false);
    timer.advance(100); // pause before the (300ms) fast debounce elapses
    engine.pause();
    assert.strictEqual(engine.state, STATES.PAUSED);
    // speech while paused must be ignored
    engine.processTranscript('How do you handle large volumes in Boomi?', true);
    timer.advance(5000);
    await flush();
    assert.strictEqual(mocks.fastCount(), 0, 'no fast calls while paused');
    assert.strictEqual(mocks.answerCount(), 0, 'no answer calls while paused');

    engine.resume();
    assert.strictEqual(engine.state, STATES.LISTENING);
    assert.strictEqual(engine.questionBuffer, '', 'stale question buffer must not replay');
    // fresh speech after resume works normally
    engine.processTranscript('What is a Molecule?', false);
    timer.advance(1000);
    await flush();
    assert.strictEqual(mocks.fastCount(), 1, 'post-resume speech should trigger fast path');
  });

  await checkAsync('pause invalidates in-flight final', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    const rendered = [];
    engine.onAnswer = ({ text, provisional }) => rendered.push({ text, provisional });
    engine.start();
    engine.processTranscript('What is a Cloud Hub?', true);
    timer.advance(1000);
    await flush();
    const inFlight = mocks.calls.answer.find(r => !r.resolved);
    assert.ok(inFlight);
    engine.pause();
    inFlight.deferred.resolve('late answer while paused');
    await flush();
    const nonProvisional = rendered.filter(r => !r.provisional);
    assert.ok(nonProvisional.length === 0, 'answer arriving after pause must not render');
  });

  // ============================================================
  console.log('\n== Regenerate ==');
  // ============================================================

  await checkAsync('regenerate uses current question + guards concurrency', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('How do you process a million records in Boomi?', true);
    timer.advance(1000);
    await flush();
    mocks.resolveNextAnswer('final answer v1');
    await flush();
    assert.strictEqual(engine.contextHistory.length, 1);

    const p1 = engine.regenerate();
    const p2 = engine.regenerate(); // duplicate while in flight must be ignored
    const first = mocks.calls.answer[mocks.calls.answer.length - 1];
    const countAfterRegenStart = mocks.answerCount();
    first.deferred.resolve('final answer v2');
    await Promise.all([p1, p2]);
    await flush();
    assert.strictEqual(mocks.answerCount(), countAfterRegenStart, 'duplicate regenerate must not add a request');
    assert.strictEqual(engine.currentAnswer, 'final answer v2');
    assert.strictEqual(engine.contextHistory[0].a, 'final answer v2', 'context history answer updated');
  });

  await checkAsync('regenerate failure keeps the valid answer', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('What is Boomi?', true);
    timer.advance(1000);
    await flush();
    mocks.resolveNextAnswer('good answer');
    await flush();

    const p = engine.regenerate();
    const inFlight = mocks.calls.answer[mocks.calls.answer.length - 1];
    inFlight.deferred.reject(new Error('Groq 429'));
    await p;
    await flush();
    assert.strictEqual(engine.currentAnswer, 'good answer', 'failure must not destroy the valid answer');
    assert.strictEqual(engine.state, STATES.READY);
  });

  // ============================================================
  console.log('\n== Follow-up context ==');
  // ============================================================

  await checkAsync('follow-up prompt references previous Q/A', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('How do you process large volumes?', true);
    timer.advance(1000);
    await flush();
    mocks.resolveNextAnswer('The main approach is batching.');
    await flush();

    engine.processTranscript('What happens when some records fail?', true);
    timer.advance(1000);
    await flush();
    const followupPrompt = mocks.lastAnswerText();
    assert.ok(engine.contextHistory.length === 1);
    const sysMsg = mocks.calls.answer[mocks.calls.answer.length - 1].messages[0].content;
    assert.ok(sysMsg.includes('Q1: How do you process large volumes?'), 'system prompt must carry follow-up context');
    assert.ok(followupPrompt.includes('some records fail'), 'question text must be the follow-up');
  });

  // ============================================================
  console.log('\n== Prompt design ==');
  // ============================================================

  await checkAsync('answer prompt: no AI filler, adaptive length, first-person for experience', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.type = 'experience';
    engine.direction = 'Mention Try/Catch error isolation.';
    const msgs = engine.buildAnswerPrompt('Have you worked with Boomi error handling?', 'final');
    const sys = msgs[0].content;
    assert.ok(sys.includes('CANDIDATE'));
    assert.ok(sys.includes('first person'));
    assert.ok(sys.includes('2-3 crisp, natural spoken sentences'), 'crisp length/format hint expected');
    assert.ok(sys.includes('Focus on the exact technical mechanism'), 'must focus on the mechanism');
    assert.ok(sys.includes('Do not give generic definitions'), 'must ban generic definitions');
    assert.ok(sys.includes('Avoid filler openers'), 'prompt must explicitly ban AI filler');
    assert.ok(!/^As an AI/i.test(sys), 'no literal "As an AI" opening');
    assert.ok(sys.includes('Try/Catch'), 'direction injected');
    assert.strictEqual(msgs[1].content, 'Question: "Have you worked with Boomi error handling?"');
  });

  await checkAsync('fast prompt: strict JSON + incomplete fallback', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    const msgs = engine.buildFastPrompt('How would you handle');
    const sys = msgs[0].content;
    assert.ok(sys.includes('STRICT JSON'));
    assert.ok(sys.includes('incomplete'));
    assert.ok(sys.includes('Boomi'), 'domain context present');
  });

  // ============================================================
  console.log('\n== Error resilience ==');
  // ============================================================

  await checkAsync('Groq failure -> ERROR state, engine alive, later transcript retries', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('What is a Process Property in Boomi?', true);
    timer.advance(1000);
    await flush();
    const inFlight = mocks.calls.answer[mocks.calls.answer.length - 1];
    inFlight.deferred.reject(new Error('Groq 500'));
    await flush();
    assert.strictEqual(engine.state, STATES.ERROR);

    // later, the interviewer extends/refines the question -> clean retry
    engine.processTranscript('What is a Process Property in Boomi and how do you set it?', true);
    timer.advance(1000);
    await flush();
    const retry = mocks.calls.answer[mocks.calls.answer.length - 1];
    assert.ok(retry, 'later transcript should trigger a clean retry');
    retry.deferred.resolve('retried answer');
    await flush();
    assert.strictEqual(engine.state, STATES.READY);
  });

  await checkAsync('fast-path failure does not break subsequent flow', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('How would you design it', false);
    timer.advance(1000);
    await flush();
    const fast = mocks.calls.fast[mocks.calls.fast.length - 1];
    fast.deferred.reject(new Error('network'));
    await flush();
    // final question still works
    engine.processTranscript('How would you design it in Boomi?', true);
    timer.advance(1000);
    await flush();
    assert.strictEqual(mocks.answerCount(), 1, 'final answer still triggered after fast-path failure');
    mocks.resolveNextAnswer('I would approach that by...');
    await flush();
    assert.strictEqual(engine.state, STATES.READY);
  });

  // ============================================================
  console.log('\n== Long-session idle behavior ==');
  // ============================================================

  await checkAsync('after idle timeout READY returns to LISTENING', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    engine.start();
    engine.processTranscript('What is Boomi?', true);
    timer.advance(1000);
    await flush();
    mocks.resolveNextAnswer('answer');
    await flush();
    assert.strictEqual(engine.state, STATES.READY);
    timer.advance(16000); // idleMs 15000
    assert.strictEqual(engine.state, STATES.LISTENING);
    // answer retained
    assert.strictEqual(engine.currentAnswer, 'answer');
  });

  // ============================================================
  console.log('\n== Question boundary intelligence (~1s pause) ==');
  // ============================================================

  await checkAsync('~1s pause boundary finalizes a complete question (no is_final needed)', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    let finalText = '';
    engine.onAnswer = ({ text, provisional }) => { if (!provisional) finalText = text; };
    engine.start();
    engine.processTranscript('How would you handle one lakh records in Boomi', false); // interim only
    timer.advance(1100); // silence crosses pauseBoundaryMs=1000 -> boundary
    await flush();
    assert.strictEqual(mocks.answerCount(), 1, 'one answer request (draft promoted)');
    mocks.resolveNextAnswer('For high volume I would first use batching and parallel processing.');
    await flush();
    assert.strictEqual(finalText, 'For high volume I would first use batching and parallel processing.');
    assert.strictEqual(engine.state, STATES.ANSWER_READY);
    assert.strictEqual(engine.contextHistory.length, 1);
  });

  await checkAsync('speech_final boundary finalizes immediately', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    let finalText = '';
    engine.onAnswer = ({ text, provisional }) => { if (!provisional) finalText = text; };
    engine.start();
    engine.processTranscript('Tell me about your current project', false);
    timer.advance(300); // draft would fire at 800 — boundary arrives first
    engine.handleSpeechBoundary('speech_final');
    await flush();
    assert.strictEqual(mocks.answerCount(), 1, 'boundary triggers one final answer');
    mocks.resolveNextAnswer('My current project is a Boomi integration layer.');
    await flush();
    assert.strictEqual(finalText, 'My current project is a Boomi integration layer.');
    assert.strictEqual(engine.state, STATES.ANSWER_READY);
  });

  await checkAsync('incomplete question + 1s pause -> WAITING_FOR_MORE, no answer', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    let finalRendered = 0;
    engine.onAnswer = ({ provisional }) => { if (!provisional) finalRendered++; };
    engine.start();
    engine.processTranscript('How would you handle', false);
    timer.advance(2500);
    await flush();
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"x","type":"incomplete","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(finalRendered, 0, 'incomplete question must never finalize');
    assert.strictEqual(engine.state, STATES.WAITING_FOR_MORE);
  });

  await checkAsync('long scenario keeps waiting until it finishes', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    let finalRendered = 0;
    engine.onAnswer = ({ provisional }) => { if (!provisional) finalRendered++; };
    engine.start();
    engine.processTranscript('Suppose production suddenly starts receiving ten times the normal volume', false);
    timer.advance(1200); // pause but the scenario is still being set up
    engine.processTranscript('Suppose production suddenly starts receiving ten times the normal volume what would you do', false);
    timer.advance(1100); // now it is a complete question -> boundary finalizes
    await flush();
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"scenario","type":"scenario","direction":"d","hint":"h"}');
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('I would isolate and scale the pipeline.');
    await flush();
    assert.strictEqual(finalRendered, 1, 'scenario finalizes once complete');
    assert.strictEqual(engine.state, STATES.ANSWER_READY);
  });

  await checkAsync('linguistic locking: trailing preposition never finalizes (long pause)', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    let finalRendered = 0;
    engine.onAnswer = ({ provisional }) => { if (!provisional) finalRendered++; };
    engine.start();
    // ends in a preposition -> grammatically incomplete, must wait even past the pause boundary
    engine.processTranscript('How do you integrate data between', false);
    timer.advance(3000);
    await flush();
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"integration","type":"incomplete","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(finalRendered, 0, 'trailing preposition must lock the boundary to wait');
    assert.strictEqual(engine.state, STATES.WAITING_FOR_MORE);
    // the speaker finishes the thought -> now it finalizes
    engine.processTranscript('How do you integrate data between Boomi and Salesforce?', false);
    timer.advance(1100);
    await flush();
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"integration","type":"conceptual","direction":"d","hint":"h"}');
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('I would use a Boomi connector.');
    await flush();
    assert.strictEqual(finalRendered, 1, 'completed sentence finalizes normally');
    assert.strictEqual(engine.state, STATES.ANSWER_READY);
  });

  await checkAsync('linguistic locking: ending in "for" stays waiting even on pause', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    let finalRendered = 0;
    engine.onAnswer = ({ provisional }) => { if (!provisional) finalRendered++; };
    engine.start();
    engine.processTranscript('What do you use SFTP for', false);
    timer.advance(3000);
    await flush();
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"sftp","type":"incomplete","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(finalRendered, 0, 'trailing "for" must not finalize');
    assert.strictEqual(engine.state, STATES.WAITING_FOR_MORE);
  });

  await checkAsync('speculative drafting: draft fires at the fast debounce before the boundary', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    let provisional = 0;
    engine.onAnswer = ({ provisional: p }) => { if (p) provisional++; };
    engine.start();
    engine.processTranscript('How would you handle one lakh records in Boomi', false);
    timer.advance(250); // draftDebounceMs=200, fastDebounceMs=300 -> draft fires first
    await flush();
    assert.strictEqual(mocks.answerCount(), 1, 'draft should fire quickly on the core keyword');
    assert.ok(mocks.pendingAnswerCount() > 0, 'draft request in flight');
    mocks.resolveNextAnswer('I would use batching and parallel processing.');
    await flush();
    assert.strictEqual(provisional, 1, 'early draft rendered provisionally');
  });

  // ============================================================
  console.log('\n== Phase 5 Latency Masker (Instant Opener) ==');
  // ============================================================

  await checkAsync('final answer flashes a type-matched opener immediately (0ms)', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    // draftThreshold=100 prevents the draft path from promoting, forcing the
    // _runFinalAnswer path where the opener is flashed.
    const engine = makeEngine(timer, mocks, { cfg: { draftThreshold: 100 } });
    const rendered = [];
    engine.onAnswer = ({ text, provisional }) => rendered.push({ text, provisional });
    engine.start();
    engine.processTranscript('What is an Atom in Boomi?', true);
    timer.advance(1000);
    await flush();
    const req = mocks.calls.answer.find(r => !r.resolved);
    assert.ok(req, 'final answer request in flight');
    // the opener must already be on screen before the API resolves
    const openerProvisional = rendered.find(r => r.provisional && r.text !== '');
    assert.ok(openerProvisional, 'opener flashed while API in flight');
    req.deferred.resolve('An Atom is the smallest runtime.');
    await flush();
    const finals = rendered.filter(r => !r.provisional && r.text !== '');
    assert.ok(finals.length === 1, 'one final answer rendered');
    assert.ok(finals[0].text.startsWith(openerProvisional.text), 'final answer prepends the opener');
    assert.ok(finals[0].text.includes('An Atom is the smallest runtime.'), 'API body preserved');
  });

  await checkAsync('type-matched openers: scenario uses scenario openers', async () => {
    const engine = new InterviewEngine({ openersEnabled: true });
    engine.type = 'scenario';
    engine.processTranscript = () => {}; // no-op; we only test opener selection indirectly
    const systemContent = engine.buildAnswerPrompt('How would you handle a million records?', 'final')[0].content;
    assert.ok(systemContent.includes('CRITICAL RULE: Do NOT start your answer with pleasantries'), 'prompt forbids LLM-generated pleasantries');
  });

  await checkAsync('openers can be disabled for exact-text pipelines', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    let finalText = '';
    engine.onAnswer = ({ text, provisional }) => { if (!provisional) finalText = text; };
    engine.start();
    engine.processTranscript('How do you process a million records in Boomi?', true);
    timer.advance(1000);
    await flush();
    mocks.resolveNextAnswer('I would first batch them into manageable chunks.');
    await flush();
    assert.strictEqual(finalText, 'I would first batch them into manageable chunks.', 'exact API text preserved when openers disabled');
  });

  // ============================================================
  console.log('\n== 3-tier question candidates ==');
  // ============================================================

  await checkAsync('candidates parsed, ranked; primary drives answer prompt', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('How would you handle large volume records in Boomi', false);
    timer.advance(1000);
    await flush();
    mocks.resolveNextFast('{"topic":"volume","type":"scenario","direction":"Focus on batching and parallel processing","hint":"b -> p","candidates":[{"interpretation":"High-volume Boomi processing","confidence":"HIGH"},{"interpretation":"Performance tuning","confidence":"MEDIUM"},{"interpretation":"Architecture design","confidence":"LOW"}]}');
    await flush();
    assert.strictEqual(engine.candidates.length, 3);
    assert.strictEqual(engine.candidates[0].confidence, 'HIGH');
    assert.strictEqual(engine.candidates[0].priority, 1);
    assert.strictEqual(engine.primary.text, 'High-volume Boomi processing');
    const msgs = engine.buildAnswerPrompt('How would you handle large volume records in Boomi', 'final');
    assert.ok(msgs[1].content.includes('High-volume Boomi processing'), 'primary interpretation anchors the answer prompt');
    // hint derived from the selected direction
    assert.ok(engine.hint, 'hint present');
  });

  // ============================================================
  console.log('\n== Turn IDs + normalization ==');
  // ============================================================

  await checkAsync('turn IDs are monotonic across questions', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('What is Boomi', false);
    assert.strictEqual(engine.turnId, 'turn_001');
    engine.processTranscript('How do you handle errors', false); // new utterance
    assert.strictEqual(engine.turnId, 'turn_002');
  });

  check('normalizeTranscript trims + collapses repeated words', () => {
    assert.strictEqual(
      normalizeTranscript('  How   would  you  handle  the the records  '),
      'How would you handle the records'
    );
    assert.strictEqual(normalizeTranscript('Tell me about Boomi API and SFTP'), 'Tell me about Boomi API and SFTP');
  });

  check('parseJsonObject extracts 3-tier candidates', () => {
    const obj = parseJsonObject('{"topic":"x","type":"scenario","direction":"d","hint":"h","candidates":[{"interpretation":"A","confidence":"HIGH"},{"interpretation":"B","confidence":"MEDIUM"}]}');
    assert.strictEqual(obj.candidates.length, 2);
    assert.strictEqual(obj.candidates[0].interpretation, 'A');
  });

  check('toConfidence normalizes labels', () => {
    assert.strictEqual(toConfidence('high'), 'HIGH');
    assert.strictEqual(toConfidence('MEDIUM'), 'MEDIUM');
    assert.strictEqual(toConfidence('low confidence'), 'LOW');
  });

  // ============================================================
  console.log('\n== Boundary + stale protection ==');
  // ============================================================

  await checkAsync('new question supersedes in-flight promoted draft', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    const rendered = [];
    engine.onAnswer = ({ text, provisional }) => rendered.push({ text, provisional });
    engine.start();
    engine.processTranscript('What is a Process Property', false);
    timer.advance(1000);
    await flush();
    const draftReq = mocks.calls.answer.find(r => !r.resolved);
    assert.ok(draftReq, 'draft in flight');

    // interviewer immediately starts a NEW question before the draft resolves
    engine.processTranscript('Why did you choose that architecture', false);
    timer.advance(1000);
    await flush();
    const newer = mocks.calls.answer.find(r => !r.resolved && r !== draftReq);
    assert.ok(newer, 'newer question triggered its own request');

    newer.deferred.resolve('answer for new question');
    await flush();
    draftReq.deferred.resolve('STALE answer for old question');
    await flush();

    const finals = rendered.filter(r => !r.provisional && r.text !== '');
    assert.strictEqual(finals[finals.length - 1].text, 'answer for new question', 'stale draft must not overwrite the new question');
  });

  // ============================================================
  console.log('\n== Semantic change classification (Phase 2 §14) ==');
  // ============================================================

  check('MINOR: single filler word added', () => {
    assert.strictEqual(classifySemanticChange('How would you handle', 'How would you handle a'), 'MINOR');
  });
  check('MEANINGFUL: question gains real content', () => {
    assert.strictEqual(classifySemanticChange('How would you handle', 'How would you handle large volume records'), 'MEANINGFUL');
  });
  check('MAJOR: domain term arrives', () => {
    assert.strictEqual(classifySemanticChange('How would you handle large volume records', 'How would you handle large volume records in Boomi'), 'MAJOR');
  });
  check('MAJOR: type flip', () => {
    assert.strictEqual(classifySemanticChange('What is an Atom', 'Why did you choose that approach', 'conceptual', 'followup'), 'MAJOR');
  });
  check('first utterance of a turn is MAJOR', () => {
    assert.strictEqual(classifySemanticChange('', 'How would you handle errors'), 'MAJOR');
  });

  // ============================================================
  console.log('\n== Short follow-up turns (Phase 2 §19) ==');
  // ============================================================

  check('isShortFollowup: Why? with context', () => {
    assert.strictEqual(isShortFollowup('Why?', true), true);
    assert.strictEqual(isShortFollowup('What about?', true), true);
    assert.strictEqual(isShortFollowup('Why', true), true);
  });
  check('isShortFollowup: without context -> false', () => {
    assert.strictEqual(isShortFollowup('Why?', false), false);
    assert.strictEqual(isShortFollowup('Why?', undefined), false);
  });
  check('classifyQuestionType: lone Why? -> followup with context', () => {
    const a = classifyQuestionType('Why?', true);
    assert.strictEqual(a.type, 'followup');
    assert.strictEqual(a.isIncomplete, false);
  });
  check('classifyQuestionType: lone Why? still incomplete without context', () => {
    const a = classifyQuestionType('Why?', false);
    assert.strictEqual(a.type, 'incomplete');
  });

  // ============================================================
  console.log('\n== Question snapshots + turn archival (Phase 2 §21/§25) ==');
  // ============================================================

  await checkAsync('boundary creates an immutable snapshot with all fields', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('How would you handle errors in Boomi', true);
    timer.advance(1100); // crosses pauseBoundaryMs=1000
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('answer');
    await flush();
    const snap = engine.getLatestSnapshot();
    assert.ok(snap, 'snapshot exists');
    assert.strictEqual(Object.isFrozen(snap), true, 'snapshot is immutable');
    assert.strictEqual(snap.turnId, 'turn_001');
    assert.strictEqual(snap.transcript, 'How would you handle errors in Boomi');
    assert.ok(snap.timestamp > 0);
    assert.strictEqual(snap.questionState, 'QUESTION_COMPLETE');
    assert.strictEqual(snap.isInterim, false);
    assert.strictEqual(snap.isFinal, true);
    assert.strictEqual(snap.previousTurnId, '');
    assert.strictEqual(snap.decision, 'finalize');
  });

  await checkAsync('speech_final boundary captures speechFinal=true in snapshot', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('Tell me about your current project', false);
    timer.advance(300);
    engine.handleSpeechBoundary('speech_final');
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('answer');
    await flush();
    const snap = engine.getLatestSnapshot();
    assert.ok(snap);
    assert.strictEqual(snap.speechFinal, true);
  });

  await checkAsync('previous turn snapshot preserved when a new turn begins', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    // Turn 1
    engine.processTranscript('What is an Atom', false);
    timer.advance(1100);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('atom answer');
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"atom","type":"conceptual","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(engine.getLatestSnapshot().turnId, 'turn_001');
    // Turn 2 starts -> turn_001 archived
    engine.processTranscript('What is a Molecule', false);
    timer.advance(1100);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('molecule answer');
    await flush();
    assert.strictEqual(engine.getLatestSnapshot().turnId, 'turn_002', 'current snapshot is turn 2');
    assert.ok(engine.getPreviousSnapshot(), 'previous snapshot exists');
    assert.strictEqual(engine.getPreviousSnapshot().turnId, 'turn_001', 'archived turn 1');
    assert.strictEqual(engine.getLatestSnapshot().previousTurnId, 'turn_001', 'turn 2 knows its previous turn');
  });

  await checkAsync('turn snapshot archive is bounded (maxSnapshots)', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { cfg: { maxSnapshots: 3 } });
    engine.start();
    const questions = [
      'What is an Atom',
      'What is a Molecule',
      'What is a Cloud Hub',
      'What is a Process Property',
      'What is a Connector',
      'What is a Listener'
    ];
    for (let i = 0; i < questions.length; i++) {
      engine.processTranscript(questions[i], false);
      timer.advance(1100);
      await flush();
      while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('answer ' + i);
      while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"q","type":"conceptual","direction":"d","hint":"h"}');
      await flush();
    }
    assert.ok(engine.getTurnSnapshots().length <= 3, 'archive stays bounded');
    assert.strictEqual(engine.getTurnSnapshots().length, 3);
  });

  await checkAsync('clear invalidates current turn snapshot but keeps archive', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('What is Boomi', false);
    timer.advance(1100);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('answer');
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"boomi","type":"conceptual","direction":"d","hint":"h"}');
    await flush();
    assert.ok(engine.getLatestSnapshot());
    const archived = engine.getTurnSnapshots().length;
    engine.clear();
    assert.strictEqual(engine.getLatestSnapshot(), null, 'current snapshot cleared');
    assert.strictEqual(engine.getTurnSnapshots().length, archived, 'archive preserved');
  });

  await checkAsync('pause blocks snapshot creation; resume starts fresh', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.pause();
    engine.processTranscript('How would you handle large volumes', false);
    timer.advance(2000);
    await flush();
    assert.strictEqual(mocks.answerCount(), 0, 'no answer calls while paused');
    assert.strictEqual(engine.getLatestSnapshot(), null, 'no snapshot while paused');
    engine.resume();
    engine.processTranscript('How do you process large volumes in Boomi', false);
    timer.advance(1100);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('answer');
    await flush();
    assert.ok(engine.getLatestSnapshot(), 'snapshot created after resume');
  });

  // ============================================================
  console.log('\n== Follow-up turn retention (Phase 2 §19 / Test 9) ==');
  // ============================================================

  await checkAsync('follow-up "Why?" becomes its own turn with context', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.start();
    engine.processTranscript('How do you handle errors', false);
    timer.advance(1100);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('I use try/catch.');
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"errors","type":"troubleshooting","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(engine.contextHistory.length, 1);

    // follow-up begins a new turn, previous retained
    engine.processTranscript('Why?', true);
    timer.advance(1100);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('Because isolation limits blast radius.');
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"why","type":"followup","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(engine.getLatestSnapshot().turnId, 'turn_002', 'follow-up gets its own turn');
    assert.ok(engine.contextHistory.length >= 1, 'previous turn retained');
    const sys = mocks.calls.answer[mocks.calls.answer.length - 1].messages[0].content;
    assert.ok(sys.includes('Q1: How do you handle errors'), 'follow-up prompt references previous Q/A');
  });

  // ============================================================
  console.log('\n== Phase 6 — Conversation memory + confidence scoring ==');
  // ============================================================

  await checkAsync('completed turn pushes exchange into rolling conversation history', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    engine.start();
    engine.processTranscript('What is a Process Property in Boomi?', true);
    timer.advance(1000);
    await flush();
    mocks.resolveNextAnswer('A reusable parameter scoped to a process.');
    await flush();
    assert.strictEqual(engine.conversationHistory.length, 2, 'user + assistant exchange recorded');
    assert.strictEqual(engine.conversationHistory[0].role, 'user');
    assert.strictEqual(engine.conversationHistory[0].content, 'What is a Process Property in Boomi?');
    assert.strictEqual(engine.conversationHistory[1].role, 'assistant');
    assert.strictEqual(engine.conversationHistory[1].content, 'A reusable parameter scoped to a process.');
  });

  await checkAsync('conversation history is injected before the current user prompt', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    engine.start();
    engine.processTranscript('How do you batch records?', true);
    timer.advance(1000);
    await flush();
    mocks.resolveNextAnswer('Batching groups records into documents.');
    await flush();

    engine.processTranscript('What happens on a failure?', true);
    timer.advance(1000);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('On failure I isolate with Try/Catch and retry.');
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"failure","type":"troubleshooting","direction":"d","hint":"h"}');
    await flush();
    const msgs = mocks.calls.answer[mocks.calls.answer.length - 1].messages;
    const last = msgs[msgs.length - 1];
    assert.strictEqual(last.role, 'user', 'current user prompt stays last');
    assert.ok(last.content.includes('failure'), 'current question is the follow-up');
    assert.strictEqual(msgs[0].role, 'system', 'system message stays first');
    const histUser = msgs.find(m => m.role === 'user' && m.content.includes('batch records'));
    assert.ok(histUser, 'previous user turn injected into the messages array');
    assert.strictEqual(engine.conversationHistory.length, 4, 'two turns => 4 messages');
  });

  await checkAsync('conversation history is capped at the last 8 messages', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    engine.start();
    for (let i = 1; i <= 5; i++) {
      engine.processTranscript('Question number ' + i + ' about Boomi?', true);
      timer.advance(1000);
      await flush();
      mocks.resolveNextAnswer('Answer number ' + i + '.');
      await flush();
      // let idle/LISTENING settle so the next transcript starts a fresh turn
      timer.advance(16000);
      await flush();
    }
    assert.strictEqual(engine.conversationHistory.length, 8, 'capped at 4 turns / 8 messages');
    assert.strictEqual(engine.conversationHistory[0].content, 'Question number 2 about Boomi?', 'oldest turn dropped');
    assert.strictEqual(engine.conversationHistory[7].content, 'Answer number 5.', 'newest assistant kept');
  });

  await checkAsync('final answer carries Green/Yellow/Red confidence from the turn score', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    let lastConfidence = null;
    engine.onAnswer = ({ provisional, confidence }) => { if (!provisional) lastConfidence = confidence; };
    engine.start();
    // strong question -> score well above 60 -> green
    engine.processTranscript('How would you design a large volume integration in Boomi with error handling?', true);
    timer.advance(1000);
    await flush();
    mocks.resolveNextAnswer('strong answer');
    await flush();
    assert.strictEqual(lastConfidence, 'green', 'high-score turn must be green, got ' + lastConfidence);
    assert.ok(engine.confidence >= 60, 'score sanity check: ' + engine.confidence);
  });

  await checkAsync('low-score turn yields yellow confidence', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false });
    let lastConfidence = null;
    engine.onAnswer = ({ provisional, confidence }) => { if (!provisional) lastConfidence = confidence; };
    engine.start();
    // force a low-ish turn score directly so the boundary still fires but the
    // confidence indicator lands on yellow (35-59)
    engine.processTranscript('How do you handle errors?', true);
    engine.confidence = 40;
    timer.advance(1000);
    await flush();
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('Isolate with Try/Catch and retry.');
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"errors","type":"troubleshooting","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(lastConfidence, 'yellow', 'mid-score turn must be yellow, got ' + lastConfidence);
  });

  // ============================================================
  console.log('\n== Phase 7 — Scenario Interceptor (local fast-path) ==');
  // ============================================================

  const scenarioBank = [
    { id: 'boomi_atom_vs_molecule', keywords: ['difference', 'between', 'atom', 'molecule'], answer: 'An Atom is single-node; a Molecule is a clustered multi-node runtime.', type: 'comparison' },
    { id: 'boomi_process_property', keywords: ['what', 'is', 'process', 'property'], answer: 'A Process Property is a globally defined process value.', type: 'conceptual' }
  ];

  check('_searchLocalScenarios matches only when every keyword is present', () => {
    const engine = new InterviewEngine({ scenarioBank, openersEnabled: false });
    assert.strictEqual(
      engine._searchLocalScenarios('What is the difference between an Atom and a Molecule?'),
      scenarioBank[0].answer
    );
    assert.strictEqual(
      engine._searchLocalScenarios('What is a Process Property in Boomi?'),
      scenarioBank[1].answer
    );
    assert.strictEqual(engine._searchLocalScenarios('How do you handle error retries?'), null, 'no full-keyword match -> null');
    assert.strictEqual(engine._searchLocalScenarios('What is an Atom?'), null, 'missing molecule/difference keywords -> null');
  });

  check('_searchLocalScenarios is case-insensitive and order-independent', () => {
    const engine = new InterviewEngine({ scenarioBank, openersEnabled: false });
    assert.strictEqual(
      engine._searchLocalScenarios('MOLECULE vs ATOM, what is the DIFFERENCE and BETWEEN?'),
      scenarioBank[0].answer
    );
  });

  await checkAsync('local scenario match skips the Groq API entirely', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    // draftThreshold 999 forces the _runFinalAnswer path (no background draft)
    const engine = makeEngine(timer, mocks, { openersEnabled: false, scenarioBank, cfg: { draftThreshold: 999 } });
    let finalText = '';
    engine.onAnswer = ({ text, provisional }) => { if (!provisional) finalText = text; };
    engine.start();
    engine.processTranscript('What is the difference between an Atom and a Molecule?', true);
    timer.advance(1000);
    await flush();
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"atom","type":"comparison","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(mocks.answerCount(), 0, 'no answer API call when a local scenario matches');
    assert.strictEqual(finalText, scenarioBank[0].answer, 'final answer comes from the local bank');
    assert.strictEqual(engine.state, STATES.READY);
    assert.strictEqual(engine.conversationHistory.length, 2, 'exchange still recorded into memory');
  });

  await checkAsync('local scenario match prepends the type-matched opener when enabled', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: true, scenarioBank, cfg: { draftThreshold: 999 } });
    let finalText = '';
    engine.onAnswer = ({ text, provisional }) => { if (!provisional) finalText = text; };
    engine.start();
    engine.type = 'conceptual';
    engine.processTranscript('What is a Process Property in Boomi?', true);
    timer.advance(1000);
    await flush();
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"property","type":"conceptual","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(mocks.answerCount(), 0, 'no Groq call on local hit');
    assert.ok(finalText.endsWith(scenarioBank[1].answer), 'answer content is the local scenario');
    const conceptualOpeners = ['To explain that simply,', 'When looking at that concept,', 'There are a few key points there.'];
    assert.ok(conceptualOpeners.some(o => finalText.startsWith(o)), 'conceptual opener prepended: ' + finalText);
  });

  await checkAsync('draft path also intercepts local scenarios (no Groq call)', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    // default draftThreshold -> the speculative draft fires first and intercepts
    const engine = makeEngine(timer, mocks, { openersEnabled: false, scenarioBank });
    let finalText = '';
    engine.onAnswer = ({ text, provisional }) => { if (!provisional) finalText = text; };
    engine.start();
    engine.processTranscript('What is the difference between an Atom and a Molecule?', true);
    timer.advance(1000);
    await flush();
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"atom","type":"comparison","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(mocks.answerCount(), 0, 'draft path must not hit the API either');
    assert.strictEqual(finalText, scenarioBank[0].answer, 'promoted draft carries the local answer');
    assert.strictEqual(engine.conversationHistory.length, 2, 'exchange recorded via the promote path');
  });

  await checkAsync('no local match falls through to the Groq API', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false, scenarioBank });
    engine.start();
    engine.processTranscript('How do you handle a large volume of records?', true);
    timer.advance(1000);
    await flush();
    assert.ok(mocks.answerCount() >= 1, 'API called when no scenario matches');
    while (mocks.pendingAnswerCount()) mocks.resolveNextAnswer('I use batching and parallel processing.');
    while (mocks.pendingFastCount()) mocks.resolveNextFast('{"topic":"volume","type":"scenario","direction":"d","hint":"h"}');
    await flush();
    assert.strictEqual(engine.state, STATES.READY);
  });

  await checkAsync('empty scenario bank never intercepts', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, { openersEnabled: false, scenarioBank: [] });
    engine.start();
    engine.processTranscript('What is the difference between an Atom and a Molecule?', true);
    timer.advance(1000);
    await flush();
    assert.ok(mocks.answerCount() >= 1, 'empty bank -> normal Groq path');
  });

  // ============================================================
  // Phase 10 Part 1 — Candidate Audio Capture (engine side)
  // ============================================================

  check('candidateAnalysisEnabled defaults to false (master lock)', () => {
    const engine = new InterviewEngine({});
    assert.strictEqual(engine.candidateAnalysisEnabled, false, 'candidate analysis locked OFF by default');
    assert.strictEqual(engine.candidateTranscript, '', 'transcript buffer starts empty');
  });

  check('handleCandidateText is a no-op while candidateAnalysisEnabled is false', () => {
    const engine = new InterviewEngine({});
    engine.handleCandidateText('I implemented an API in Boomi');
    assert.strictEqual(engine.candidateTranscript, '', 'no append while locked off');
  });

  check('handleCandidateText accumulates the candidate answer while enabled', () => {
    const engine = new InterviewEngine({});
    engine.candidateAnalysisEnabled = true;
    engine.handleCandidateText('I used Process Property');
    engine.handleCandidateText('to parameterize the shape.');
    assert.ok(engine.candidateTranscript.includes('Process Property'), 'first fragment appended');
    assert.ok(engine.candidateTranscript.includes('parameterize'), 'second fragment appended');
  });

  // ============================================================
  // Phase 10 Part 2 — Candidate Response Analysis & Scoring
  // ============================================================

  check('analyzeCandidateResponse returns null when there is no candidate transcript', async () => {
    const engine = new InterviewEngine({ answerCall: async () => '{}' });
    engine.candidateTranscript = '';
    const score = await engine.analyzeCandidateResponse();
    assert.strictEqual(score, null, 'nothing to grade -> null');
  });

  check('analyzeCandidateResponse returns null when no API call is wired', async () => {
    const engine = new InterviewEngine({});
    engine.candidateTranscript = 'I would use a Process Property to hold the value.';
    const score = await engine.analyzeCandidateResponse();
    assert.strictEqual(score, null, 'no apiCall/answerCall -> null');
    assert.strictEqual(engine.candidateTranscript, 'I would use a Process Property to hold the value.', 'no attempt, transcript untouched');
  });

  await checkAsync('analyzeCandidateResponse grades against the last suggested answer and clears the buffer', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.candidateAnalysisEnabled = true;
    engine.handleCandidateText('I would use a Process Property to parameterize the value.');
    engine.conversationHistory = [
      { role: 'user', content: 'What is a Process Property in Boomi?' },
      { role: 'assistant', content: 'A reusable parameter scoped to a process.' }
    ];
    const promise = engine.analyzeCandidateResponse();
    await flush();
    assert.strictEqual(mocks.answerCount(), 1, 'grader hit the API exactly once');
    const record = mocks.calls.answer[0];
    assert.strictEqual(record.messages.length, 1, 'single system prompt');
    assert.ok(record.messages[0].content.includes('A reusable parameter scoped to a process.'), 'expected answer injected');
    assert.ok(record.messages[0].content.includes('Process Property'), 'candidate transcript injected');
    mocks.resolveNextAnswer('{"accuracy": "8/10", "feedback": "Solid use of Process Properties; mention scoping."}');
    const score = await promise;
    assert.strictEqual(score.accuracy, '8/10');
    assert.ok(score.feedback.includes('Process Properties'));
    assert.strictEqual(engine.candidateTranscript, '', 'transcript cleared after grading');
  });

  await checkAsync('analyzeCandidateResponse survives markdown-wrapped JSON', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.candidateTranscript = 'I would batch the records.';
    const promise = engine.analyzeCandidateResponse();
    await flush();
    mocks.resolveNextAnswer('```json\n{"accuracy": "7/10", "feedback": "Add a retry policy."}\n```');
    const score = await promise;
    assert.strictEqual(score.accuracy, '7/10');
    assert.strictEqual(score.feedback, 'Add a retry policy.');
  });

  await checkAsync('analyzeCandidateResponse returns null on malformed grader output but still clears the buffer', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks);
    engine.candidateTranscript = 'Not a great answer.';
    const promise = engine.analyzeCandidateResponse();
    await flush();
    mocks.resolveNextAnswer('the candidate failed to answer coherently');
    const score = await promise;
    assert.strictEqual(score, null, 'unparseable response -> null');
    assert.strictEqual(engine.candidateTranscript, '', 'buffer cleared after a grading attempt');
  });

  // ============================================================
  // Phase 12 — Multi-Tier Model Split / Router (engine side)
  // ============================================================

  check('DEFAULT_CFG routerMode defaults to hybrid with tiered models', () => {
    assert.strictEqual(DEFAULT_CFG.routerMode, 'hybrid', 'hybrid routing by default');
    assert.strictEqual(DEFAULT_CFG.fastModel, 'llama-3.1-8b-instant', 'fast tier model');
    assert.strictEqual(DEFAULT_CFG.model, 'llama-3.3-70b-versatile', 'answer tier model');
  });

  check('_searchLocalScenarios returns null in agent-only mode', () => {
    const engine = new InterviewEngine({ scenarioBank, openersEnabled: false, cfg: { routerMode: 'agent-only' } });
    assert.strictEqual(
      engine._searchLocalScenarios('What is the difference between an Atom and a Molecule?'),
      null,
      'agent-only disables the local RAG layer entirely'
    );
  });

  check('_searchLocalScenarios fuzzy-matches when >=75% of keywords are present', () => {
    const engine = new InterviewEngine({ scenarioBank, openersEnabled: false });
    assert.strictEqual(
      engine._searchLocalScenarios('difference between atom'),
      scenarioBank[0].answer,
      '3 of 4 keywords (75%) -> fuzzy hit'
    );
    assert.strictEqual(
      engine._searchLocalScenarios('what is process'),
      scenarioBank[1].answer,
      '3 of 4 keywords (75%) -> fuzzy hit'
    );
  });

  check('_searchLocalScenarios stays null below the 75% fuzzy threshold', () => {
    const engine = new InterviewEngine({ scenarioBank, openersEnabled: false });
    assert.strictEqual(engine._searchLocalScenarios('difference between'), null, '2 of 4 keywords (50%) -> no hit');
    assert.strictEqual(engine._searchLocalScenarios('What is an Atom?'), null, '1 of 4 keywords (25%) -> no hit');
  });

  await checkAsync('rag-only mode returns the safe fallback with zero API calls', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, {
      openersEnabled: false,
      scenarioBank,
      cfg: { routerMode: 'rag-only', draftThreshold: 999 }
    });
    let finalText = '';
    engine.onAnswer = ({ text, provisional }) => { if (!provisional) finalText = text; };
    engine.start();
    engine.processTranscript('How do you handle large volumes of records?', true);
    timer.advance(1000);
    await flush();
    assert.strictEqual(mocks.answerCount(), 0, 'no external API in rag-only mode');
    assert.strictEqual(mocks.fastCount(), 0, 'no fast-path API either');
    assert.strictEqual(finalText, 'I focus on Boomi integration architecture. Could you clarify your question?', 'safe fallback used');
    assert.strictEqual(engine.conversationHistory.length, 2, 'exchange still recorded into memory');
  });

  await checkAsync('rag-only mode still uses a local scenario when it fuzzy-matches', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, {
      openersEnabled: false,
      scenarioBank,
      cfg: { routerMode: 'rag-only', draftThreshold: 999 }
    });
    let finalText = '';
    engine.onAnswer = ({ text, provisional }) => { if (!provisional) finalText = text; };
    engine.start();
    engine.processTranscript('What is the difference between atom and molecule?', true);
    timer.advance(1000);
    await flush();
    assert.strictEqual(mocks.answerCount(), 0, 'no API call when local scenario hits');
    assert.strictEqual(finalText, scenarioBank[0].answer, 'local scenario answer used in rag-only');
  });

  await checkAsync('rag-only draft path also falls back locally with no API call', async () => {
    const timer = makeTimer();
    const mocks = makeMockCalls();
    const engine = makeEngine(timer, mocks, {
      openersEnabled: false,
      scenarioBank,
      cfg: { routerMode: 'rag-only' }
    });
    engine.start();
    engine.processTranscript('What is the best error handling strategy in Boomi?', true);
    timer.advance(1000);
    await flush();
    assert.strictEqual(mocks.answerCount(), 0, 'draft path never hits the API in rag-only mode');
    assert.strictEqual(engine.draftAnswer, 'I focus on Boomi integration architecture. Could you clarify your question?', 'draft marked done with fallback');
  });

  // ============================================================
  // Summary
  // ============================================================
  console.log('\n------------------------------------------');
  console.log(`PASSED: ${passed}  FAILED: ${failed}`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' - ' + f.name + ': ' + (f.err && f.err.stack || f.err)));
    process.exit(1);
  }
  console.log('ALL ENGINE TESTS PASSED');
}

main().catch(err => {
  console.error('Harness crashed:', err);
  process.exit(1);
});