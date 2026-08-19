'use strict';

// ============================================================
// Boomi Companion — Chaos Simulator (Automated Resilience Testing)
// Run: node test/chaos-simulator.js   (or: npm run test:chaos)
//
// WHAT THIS IS
//   A headless harness that replays brutal, real-world Senior Architect
//   interview conditions (STT phonetic drift, cross-module ambiguity, context
//   switching, filler floods, phantom keywords, provider blackouts) against the
//   REAL engine (engine.js, hybrid router) + the REAL Master Scenario Bank
//   (knowledge/scenarios.json, 311 entries). No microphone, no DOM, no UI.
//
// GUARDRAILS
//   This is strictly a TESTING phase. engine.js, index.html, main.js,
//   audio-pipeline.js and provider-router.js are NOT touched. The engine is
//   driven through its public API with fake timers + deferred network mocks,
//   the same pattern used by the deterministic unit suites.
//
// STREAMING MODEL
//   `simulateStream(scenario)` feeds scenario.chunks one at a time via
//   `engine.processTranscript(text, isFinal)` with a simulated silence gap
//   (fake-timer advance, default 300ms between chunks). After the final chunk a
//   900ms pause lets the engine's pause watchdog fire the boundary decision
//   (exactly like a real interviewer trailing off). The last chunk is final.
//
//   NOTE: the interviewer-question stream drives processTranscript() — that is
//   the ONLY engine path that runs _searchLocalScenarios / callWithFallback.
//   handleCandidateText() merely buffers candidate mic speech and never touches
//   the router, so it is not used for these interviewer-question scenarios.
//
// ROUTING DETECTION (observer-only, no engine changes)
//   The engine already emits diagnostics at every delivery point:
//     ANSWER_DELIVERED { source } -> source maps:
//       'local-scenario-bank' | 'rag-only-fallback'  => LOCAL_RAG
//       'cloud'                                      => CLOUD_API
//       'emergency'                                  => EMERGENCY
//       (none)                                       => NONE
//     STALE_RESPONSE_REJECTED { requestType:'draft' } => an in-flight draft was
//       aborted/superseded by a newer turn or final.
//   The final answer string is captured from onAnswer({provisional:false}).
// ============================================================

const fs = require('fs');
const path = require('path');
const { InterviewEngine } = require('../engine.js');

const BANK_PATH = path.join(__dirname, '..', 'knowledge', 'scenarios.json');
const SCENARIOS_PATH = path.join(__dirname, 'chaos-scenarios.json');

// ---------------- fake timer (deterministic wall clock) ----------------

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

const flush = () => new Promise(r => setImmediate(r));

// ---------------- network mocks ----------------

const CANNED_FAST_JSON = JSON.stringify({
  topic: 'Boomi integration',
  type: 'conceptual',
  direction: 'Cover the module boundary and the trade-offs.',
  hint: 'components -> boundary -> trade-offs',
  candidates: [
    { interpretation: 'The interviewer is asking about the Boomi integration module boundary', confidence: 'HIGH' },
    { interpretation: 'The interviewer wants the architectural trade-offs', confidence: 'MEDIUM' },
    { interpretation: 'A broader Boomi architecture question', confidence: 'LOW' }
  ]
});

// answerBehavior: 'ok' -> providers resolve; 'fail' -> every provider rejects
// (simulates a total Groq + Gemini blackout so the engine must fall back to the
// instant local emergency response and never freeze).
function makeNetwork(behavior) {
  const calls = { fast: 0, answer: 0 };
  const pending = { fast: [], answer: [] };
  return {
    calls,
    fastPathCall(messages) {
      calls.fast++;
      const d = deferred();
      pending.fast.push({ d });
      return d.promise;
    },
    answerCall(messages, mode, onChunk) {
      calls.answer++;
      const d = deferred();
      pending.answer.push({ d, mode });
      return d.promise;
    },
    // Resolve/reject everything after the boundary has been reached, so the
    // engine's promote-pending handshake (and draft supersede path) runs the
    // same way it would under real provider latency.
    settle() {
      while (pending.fast.length) {
        pending.fast.shift().d.resolve(CANNED_FAST_JSON);
      }
      while (pending.answer.length) {
        const p = pending.answer.shift();
        if (behavior === 'fail') {
          p.d.reject(new Error('provider blackout (chaos)'));
        } else {
          p.d.resolve('Simulated provider answer for the final question (chaos stream).');
        }
      }
    }
  };
}

// ---------------- chaos engine factory (real bank, observer attached) ----------------

function loadRealBank() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[CHAOS] Could not load real scenario bank:', err.message);
    return [];
  }
}

function makeChaosEngine(timer, network) {
  const events = {
    deliveries: [],          // { source, at }
    finals: [],              // { text, at } from onAnswer(provisional:false)
    abortedDrafts: 0,        // STALE_RESPONSE_REJECTED { requestType:'draft' }
    localIntercepts: 0,      // LOCAL_SCENARIO_INTERCEPT diag events
    fastStale: 0
  };
  const engine = new InterviewEngine({
    log: () => {},
    timeoutFn: timer.setTimeout.bind(timer),
    clearTimeoutFn: timer.clearTimeout.bind(timer),
    nowFn: () => timer.getNow(),
    fastPathCall: network.fastPathCall,
    answerCall: network.answerCall,
    scenarioBank: loadRealBank(),
    openersEnabled: false,
    // Sniper Mode opt-out (documented escape hatch): the chaos harness feeds
    // INCREMENTAL multi-chunk transcripts and asserts on interim-driven draft
    // aborts + mid-stream local scenario intercepts — behavior the strict
    // sniper mode (exactly 1 API call per question) removes by design. Opt out
    // so the resilience scenarios exercise the speculative pipeline they model.
    cfg: { sniperMode: false },
    diag: (evt, data) => {
      if (evt === 'ANSWER_DELIVERED') {
        events.deliveries.push({ source: data.source, at: timer.getNow() });
      } else if (evt === 'STALE_RESPONSE_REJECTED') {
        if (data.requestType === 'draft') events.abortedDrafts++;
        else if (data.requestType === 'fast_path') events.fastStale++;
      } else if (evt === 'LOCAL_SCENARIO_INTERCEPT') {
        events.localIntercepts++;
      }
    },
    onAnswer: res => {
      if (!res.provisional) events.finals.push({ text: res.text, at: timer.getNow() });
    }
  });
  return { engine, events };
}

// ---------------- the streaming simulation ----------------

const HOLD_DEFAULT = 300;   // simulated silence between chunks
const HOLD_FINAL = 900;     // silence after the last chunk -> pause watchdog boundary

function routingLabel(source) {
  if (source === 'local-scenario-bank' || source === 'rag-only-fallback') return 'LOCAL_RAG';
  if (source === 'cloud') return 'CLOUD_API';
  if (source === 'emergency') return 'EMERGENCY';
  return 'NONE';
}

async function simulateStream(scenario) {
  const timer = makeTimer();
  const network = makeNetwork(scenario.answerBehavior || 'ok');
  const { engine, events } = makeChaosEngine(timer, network);
  const holds = scenario.holdMs || [];
  const chunks = scenario.chunks || [];

  engine.start();

  let finalChunkAt = 0;
  for (let i = 0; i < chunks.length; i++) {
    const isFinal = i === chunks.length - 1;
    if (isFinal) finalChunkAt = timer.getNow(); // simulated time the final chunk lands
    engine.processTranscript(chunks[i], isFinal);
    const hold = isFinal ? HOLD_FINAL : (holds[i] != null ? holds[i] : HOLD_DEFAULT);
    timer.advance(hold);
    await flush();
  }

  // Provider latency: flush any microtasks the boundary queued, then resolve.
  await flush();
  network.settle();
  await flush();
  timer.advance(50);
  await flush();

  const last = events.deliveries[events.deliveries.length - 1];
  return {
    routing: last ? routingLabel(last.source) : 'NONE',
    source: last ? last.source : null,
    deliveries: events.deliveries,
    midStreamCount: events.deliveries.filter(d => d.at < finalChunkAt).length,
    finals: events.finals,
    finalText: events.finals.length ? events.finals[events.finals.length - 1].text : '',
    abortedDrafts: events.abortedDrafts,
    localIntercepts: events.localIntercepts,
    fastStale: events.fastStale,
    answerCalls: network.calls.answer,
    fastCalls: network.calls.fast
  };
}

// ---------------- verdicts ----------------

// Phase 5.2 — NO_MATCH is the scenario-authoring alias for "no answer was
// delivered" (the engine emits routing NONE when the boundary returns
// WAIT_FOR_MORE). Normalize so expectedRouting can use either spelling.
function normRouting(v) {
  if (v === 'NO_MATCH') return 'NONE';
  return v;
}

function verdictFor(scenario, r) {
  const problems = [];
  if (normRouting(r.routing) !== normRouting(scenario.expectedRouting)) {
    problems.push(`Routed: ${r.routing} (Expected ${scenario.expectedRouting})`);
  }
  if (scenario.expectedAborts != null && r.abortedDrafts !== scenario.expectedAborts) {
    problems.push(`Aborted ${r.abortedDrafts} draft(s) (Expected ${scenario.expectedAborts})`);
  }
  if (scenario.expectedNoMidAnswer && r.midStreamCount > 0) {
    problems.push(`Delivered ${r.midStreamCount} answer(s) mid-stream (Expected 0)`);
  }
  return {
    pass: problems.length === 0,
    problems,
    extras: r.abortedDrafts > 0 ? ` (Aborted ${r.abortedDrafts} draft${r.abortedDrafts === 1 ? '' : 's'})` : ''
  };
}

// ---------------- report ----------------

async function main() {
  const bank = loadRealBank();
  const scenarios = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8')).scenarios;

  console.log('=== CHAOS SIMULATOR — Boomi Companion (Automated Resilience Testing) ===');
  console.log(`Scenarios: ${scenarios.length} | Engine: real engine.js (hybrid router) | Bank: knowledge/scenarios.json (${bank.length} entries)`);
  console.log('Driving the interviewer stream via engine.processTranscript() with simulated silence + pause-watchdog boundaries.\n');

  const results = [];
  for (const scenario of scenarios) {
    const r = await simulateStream(scenario);
    const v = verdictFor(scenario, r);
    results.push({ scenario, r, v });

    const route = `Routed: ${r.routing}`;
    let line;
    if (v.pass) {
      line = `[PASS] ${scenario.name} -> ${route}${v.extras}`;
    } else {
      line = `[FAIL] ${scenario.name} -> ${route}`;
      const parts = [];
      if (normRouting(scenario.expectedRouting) && normRouting(r.routing) !== normRouting(scenario.expectedRouting)) parts.push(`Expected ${scenario.expectedRouting}`);
      if (scenario.expectedAborts != null && r.abortedDrafts !== scenario.expectedAborts) parts.push(`Aborted ${r.abortedDrafts} draft${r.abortedDrafts === 1 ? '' : 's'} (Expected ${scenario.expectedAborts})`);
      if (scenario.expectedNoMidAnswer && r.midStreamCount > 0) parts.push(`Mid-stream answers: ${r.midStreamCount} (Expected 0)`);
      line += parts.length ? ` (${parts.join('; ')})` : '';
    }
    console.log(line);
  }

  const passed = results.filter(x => x.v.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Summary ===');
  console.log(`PASS: ${passed} | FAIL: ${failed} | Total: ${results.length}`);

  console.log('\n=== Router observation (what each scenario actually exercised) ===');
  for (const { scenario, r } of results) {
    let pathNote;
    if (r.source === 'local-scenario-bank' || r.source === 'rag-only-fallback') {
      pathNote = `LOCAL scenario intercept (${r.answerCalls} provider call${r.answerCalls === 1 ? '' : 's'}, local draft intercepts ${r.localIntercepts})`;
    } else if (r.source === 'cloud') {
      pathNote = `provider chain via _callAnswer/callWithFallback (${r.answerCalls} answer call${r.answerCalls === 1 ? '' : 's'})`;
    } else if (r.source === 'emergency') {
      pathNote = `emergency local fallback after provider failure (${r.answerCalls} failed answer call${r.answerCalls === 1 ? '' : 's'})`;
    } else {
      pathNote = 'no routing (boundary returned WAIT_FOR_MORE)';
    }
    const finalSnippet = r.finalText ? r.finalText.slice(0, 90) + (r.finalText.length > 90 ? '...' : '') : '(none)';
    console.log(`  ${scenario.name}`);
    console.log(`    path: ${pathNote}${r.abortedDrafts ? ` | drafts aborted: ${r.abortedDrafts}` : ''}`);
    console.log(`    final: "${finalSnippet}"`);
  }

  const fails = results.filter(x => !x.v.pass);
  if (fails.length) {
    console.log('\n=== Findings (why the FAILs happened) ===');
    for (const { scenario, r } of fails) {
      const notes = [];
      if (r.routing === 'NONE') {
        notes.push('the engine never classified the utterance as a question (score below autoAnswerThreshold) so the pause boundary returned WAIT_FOR_MORE and no answer was produced');
      }
      if (scenario.id === 'mid_answer_context_switch') {
        notes.push('Chaos Patch 1 lowered draftThreshold 65->50 so chunk 1 "Explain Atom Cloud." (score 58) now creates a draft; a FAIL here means the fresh-turn pivot (chunk 2) did not supersede/abort it');
      }
      if (scenario.id === 'compound_comparison_squint') {
        notes.push('Chaos Patch 1 added COMPOUND_ENTITIES protection ("atom cloud"): a scenario whose keywords lack "cloud" is penalized x0.5, so atom_vs_molecule drops from 1.00 to 0.50 and the engine defers to the cloud; a FAIL here means the compound miss still intercepted');
      }
      if (scenario.id === 'homophone_hijack') {
        notes.push('Chaos Patch 1 added _normalizePhonetics (Adam->Atom, cue->queue, item->Atom, flom->Flow) plus a +25 indirect-question credit for "when you"/"how does"; a FAIL here means the drifty utterance still scored below question classification');
      }
      if (scenario.id === 'sarcasm_rhetorical') {
        notes.push('Chaos Patch 2 added _looksRhetorical (dismissive cues like "everyone just loves" / "at 2am" + trailing ?) which makes the boundary return wait; a FAIL here means the sarcastic line still crossed the autoAnswer threshold and generated an answer');
      }
      if (scenario.id === 'impossible_requirement') {
        notes.push('Chaos Patch 2 added leading-imperative starters (design/build/create/compare/assume/...) so "Design an architecture..." is a question (+50); a FAIL here means the imperative still scored below the autoAnswer threshold and was dropped');
      }
      if (scenario.id === 'code_aloud_null') {
        notes.push('L2 rewords the final chunk to "should I use set properties to handle that null?" so the syntax-aloud question merges into ONE turn (no "how do" fresh-turn split); the merged question length-penalizes set_properties to ~0.73 so it defers to cloud. A FAIL here means the local set_properties intercept still fired');
      }
      if (scenario.id === 'echo_repetition') {
        notes.push('L12 depends on the new knowledge/scenarios.json entry boomi_subprocess_retry (keywords retries/sub/process/handle -> 1.00); a FAIL here means the retry-in-sub-process text did not hit a STRONG local scenario');
      }
      console.log(`  ${scenario.name}: ${notes.join('; ') || 'see routed outcome above'}`);
    }
  }
  console.log('\n=== CHAOS SIMULATION COMPLETE ===');
}

main().catch(err => {
  console.error('[CHAOS] Harness crashed:', err);
  process.exit(1);
});