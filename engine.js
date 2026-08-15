'use strict';

// ============================================================
// Boomi Companion — Interview Engine (pure logic, DOM-free)
// Shared by the Electron renderer (index.html) and the Node
// test harness (test/engine.test.js).
//
// Responsibilities:
//  - Explicit question-state machine (IDLE..PAUSED) with pause
//    detection (possible -> likely -> boundary)
//  - Silence / speech-boundary watchdog driving a ~1s decision
//    (speech_final / UtteranceEnd from Deepgram are strong cues)
//  - Transcript buffer management (interim / final / question buffer)
//  - Semantic-change gating so we never call the API for every interim
//    (MINOR / MEANINGFUL / MAJOR classification, Phase 2 §14)
//  - Short follow-up turns ("Why?", "What about?") when conversation
//    context exists (Phase 2 §19)
//  - Immutable question snapshots (turnId / transcript / timestamp /
//    questionState / interim-final / speechFinal / previousTurnId) created
//    at a confirmed boundary; previous-turn snapshots are archived so a new
//    turn never destroys the prior one (Phase 2 §21 / §25)
//  - Fast Path: 3-tier ranked question candidates (HIGH/MED/LOW)
//  - Background answer preparation (draft) before the question
//    completes; the draft is PROMOTED to the final answer at the
//    speech boundary when the question is complete (no 2nd call)
//  - Final natural-answer generation with adaptive length
//  - Stale-response protection (monotonic request IDs + supersede)
//  - clear / pause / resume / regenerate consistency
//  - Conversation turn IDs (turn_001 ...) + follow-up context window
//  - Latency / event logging (no secrets ever logged here)
// ============================================================

const STATES = Object.freeze({
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  SPEECH_ACTIVE: 'SPEECH_ACTIVE',
  QUESTION_BUILDING: 'QUESTION_BUILDING',
  PAUSE_DETECTED: 'PAUSE_DETECTED',
  QUESTION_CANDIDATES_READY: 'QUESTION_CANDIDATES_READY',
  QUESTION_BOUNDARY_LIKELY: 'QUESTION_BOUNDARY_LIKELY',
  ANSWER_PREPARING: 'ANSWER_PREPARING',
  ANSWERING: 'ANSWERING',
  ANSWER_READY: 'ANSWER_READY',
  WAITING_FOR_MORE: 'WAITING_FOR_MORE',
  FOLLOW_UP: 'FOLLOW_UP',
  ERROR: 'ERROR',
  PAUSED: 'PAUSED',
  // ---- legacy aliases -> canonical state strings (kept so the
  // existing UI labels / test assertions keep working) ----
  PARTIAL_SPEECH: 'SPEECH_ACTIVE',
  UNDERSTANDING: 'QUESTION_BUILDING',
  PREPARING: 'ANSWER_PREPARING',
  READY: 'ANSWER_READY',
  NEEDS_MORE_CONTEXT: 'WAITING_FOR_MORE'
});

// Request-rate + pause control thresholds.
// Pause timeline (section 2):
//  - pausePossibleMs (<=500ms)  : POSSIBLE PAUSE      -> freeze, prep, no finalize
//  - pauseLikelyMs   (~500-800) : LIKELY PAUSE/BOUNDARY -> update hypotheses, prep
//  - pauseBoundaryMs (~800)     : STRONG BOUNDARY       -> finalize if complete
// Only silence is one input: transcript completeness, semantic stability,
// question-like language, type and previous context are combined in
// _boundaryDecision().
const { getDomainConfig } = require('./domain-vocabulary.js');

const fs = require('fs');
const path = require('path');

const DEFAULT_CFG = Object.freeze({
  domain: 'Boomi',
  model: 'llama-3.3-70b-versatile',
  fastModel: 'llama-3.1-8b-instant',
  // Phase 12 — Multi-Tier Model Split / Router: how the local RAG layer and the
  // external LLM cooperate. 'rag-only' = never call an external API (local
  // scenarios + a safe fallback); 'agent-only' = never use local scenarios;
  // 'hybrid' = local scenarios first, external LLM as the fallback.
  routerMode: 'hybrid',
  fastDebounceMs: 300,
  fastMinIntervalMs: 2500,
  draftDebounceMs: 200,
  draftMinIntervalMs: 4000,
  draftThreshold: 65,
  fastThreshold: 50,
  confirmThreshold: 55,
  // autoAnswerThreshold: question score at/below which a pause/speech_final
  // boundary still auto-fires the final answer (no Alt+R needed).
  autoAnswerThreshold: 30,
  // continueWindowMs: silence window within which a non-fresh-turn fragment is
  // APPENDED to the current question buffer instead of becoming a new turn.
  continueWindowMs: 1500,
  pausePossibleMs: 400,
  pauseLikelyMs: 700,
  pauseBoundaryMs: 800,
  minDeltaWords: 3,
  minWordsForQuestion: 3,
  ignoreShortWords: 2,
  maxCandidates: 3,
  maxContextPairs: 3,
  maxSnapshots: 10,
  idleMs: 15000
});

const DOMAIN_KB = {
  Boomi: 'Focus on Boomi integration: Atoms, Molecules, Cloud Hubs, Connectors, Try/Catch error handling, listener processes, process properties, document/record batching, parallel processing, and error isolation.',
  DevOps: 'Focus on CI/CD pipelines, Docker containerization, Kubernetes orchestration, Terraform, and cloud monitoring.'
};

// ------------------------------------------------------------
// Phase 5 — Latency Masker & Instant Opener. Safe, type-matched
// conversational openers flashed to the UI at 0ms so the candidate
// has something to say while the Groq answer streams in.
// ------------------------------------------------------------
// Phase 12 — Multi-Tier Router: safe fallback answer used when routerMode is
// 'rag-only' and no local scenario matches (external APIs are never called).
// ------------------------------------------------------------
const RAG_ONLY_FALLBACK = "I focus on Boomi integration architecture. Could you clarify your question?";

// ------------------------------------------------------------
const SAFE_OPENERS = {
  conceptual: ["To explain that simply,", "When looking at that concept,", "There are a few key points there."],
  experience: ["In my recent projects,", "Based on my experience with that,", "I've handled that a few times."],
  scenario: ["If I were facing that scenario,", "That's an interesting use case.", "Here is exactly how I would approach that."],
  troubleshooting: ["When debugging issues like that,", "The first thing I always look at is", "To isolate that specific problem,"],
  comparison: ["There are a few key differences there.", "When comparing those two approaches,", "They serve different purposes, but generally,"],
  followup: ["To expand on that,", "Looking a bit deeper into that,", "That's a fair point."],
  'best-practice': ["The recommended best practice is", "Standard architectural guidelines suggest", "To ensure maximum stability,"],
  fallback: ["Let me share my thoughts on that.", "Sure, I can speak to that."]
};

const QUESTION_STARTERS = [
  'how would', 'how do', 'how did', 'what do', 'what is', "what's", 'whats',
  'can you', 'could you', 'would you', 'tell me', 'explain', 'describe',
  'walk me', 'talk about', 'give me', 'why', 'what', 'how', 'when', 'where',
  'which', 'who', 'should', 'would', 'could', 'can', 'is', 'are', 'do',
  'did', 'does', 'have', 'has', 'were', 'was'
];

const INCOMPLETE_TRAILERS = [
  'handle', 'solve', 'fix', 'manage', 'approach', 'build', 'about', 'with',
  'for', 'work', 'it', 'them', 'that', 'this', 'what', 'how', 'why',
  'and', 'or', 'the', 'a', 'an', 'to', 'of', 'in', 'on', 'use', 'used'
];

// ------------------------------------------------------------
// Phase 4 — Flexible file-based grounding. Reads the candidate's
// resume + target JD from the local knowledge/ folder so answers
// are grounded in real experience instead of generic Boomi context.
// Safe: missing/corrupt files are simply skipped (empty context).
// ------------------------------------------------------------
function loadCandidateContext() {
  let context = '';
  try {
    const resumePath = path.join(process.cwd(), 'knowledge', 'resume.md');
    const jdPath = path.join(process.cwd(), 'knowledge', 'job-description.md');

    let resumeText = '';
    let jdText = '';

    if (fs.existsSync(resumePath)) {
      resumeText = fs.readFileSync(resumePath, 'utf8').trim();
    }
    if (fs.existsSync(jdPath)) {
      jdText = fs.readFileSync(jdPath, 'utf8').trim();
    }

    if (resumeText || jdText) {
      context = `\n\n[CANDIDATE TRUTH & TARGET JD]\n`;
      if (resumeText) context += `CANDIDATE RESUME / EXPERIENCE:\n${resumeText}\n\n`;
      if (jdText) context += `TARGET JOB DESCRIPTION FOCUS:\n${jdText}\n`;
    }
  } catch (err) {
    console.warn('[ENGINE] Error reading resume/JD knowledge files:', err.message);
  }
  return context;
}

// ------------------------------------------------------------
// Phase 7 — Master Scenario Bank. Loads knowledge/scenarios.json
// (exact-match fast-path scenarios) so common questions short-circuit
// the Groq API with a sub-10ms local keyword answer. Safe: a missing
// or malformed file yields an empty bank (engine falls back to the API).
// ------------------------------------------------------------
function loadScenarios() {
  try {
    const scenariosPath = path.join(process.cwd(), 'knowledge', 'scenarios.json');
    if (!fs.existsSync(scenariosPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[ENGINE] Error reading scenarios.json:', err.message);
    return [];
  }
}

// ------------------------------------------------------------
// Pure helpers (exported for testing)
// ------------------------------------------------------------

function wordDelta(prev, next) {
  const known = new Set(String(prev || '').toLowerCase().split(/\s+/).filter(Boolean));
  return String(next || '').toLowerCase().split(/\s+/).filter(Boolean).filter(w => !known.has(w)).length;
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

// Domain terms whose arrival in a transcript is a strong topic signal.
// Used by classifySemanticChange: adding one of these marks the change MAJOR
// even when the added fragment is short (e.g. "...records" -> "...records in Boomi").
const SIGNIFICANT_TERMS = new Set([
  'boomi', 'atom', 'atoms', 'molecule', 'molecules', 'cloud', 'hub', 'connector',
  'connectors', 'sftp', 's3', 'api', 'apis', 'oauth', 'rest', 'soap', 'sql',
  'listener', 'queue', 'queues', 'process', 'processes', 'property', 'properties',
  'extension', 'environment', 'integration', 'deployment', 'pipeline', 'retry',
  'error', 'errors', 'exception', 'batch', 'batching', 'parallel', 'architecture'
]);

// Classify how much a transcript changed between two utterances.
//   MINOR      -> cosmetic / single filler word ("...handle" -> "...handle a")
//   MEANINGFUL -> the question gained real content ("...handle" -> "...handle large volume records")
//   MAJOR      -> a domain/topic term arrived or the question type flipped
//                 ("...large volume records" -> "...large volume records in Boomi")
function classifySemanticChange(prev, next, prevType, nextType) {
  const a = String(prev || '').trim().toLowerCase();
  const b = String(next || '').trim().toLowerCase();
  if (!a) return 'MAJOR'; // first utterance of a turn
  if (a === b) return 'MINOR';
  const known = new Set(a.split(/\s+/).filter(Boolean));
  const newWords = b.split(/\s+/).filter(Boolean).filter(w => !known.has(w));
  if (newWords.length === 0) return 'MINOR';
  if (newWords.some(w => SIGNIFICANT_TERMS.has(w))) return 'MAJOR';
  if (prevType && nextType && prevType !== nextType && nextType !== 'incomplete') return 'MAJOR';
  if (newWords.length >= 2) return 'MEANINGFUL';
  if (/[?？]/.test(b) && !/[?？]/.test(a)) return 'MEANINGFUL';
  return 'MINOR';
}

// Human-readable reason for a semantic change (diagnostic use only; no LLM).
function semanticChangeReason(prev, next, cls, prevType, nextType) {
  const a = String(prev || '').trim().toLowerCase();
  const b = String(next || '').trim().toLowerCase();
  if (!a) return 'first_utterance';
  if (a === b) return 'no_change';
  if (cls === 'MAJOR') {
    const known = new Set(a.split(/\s+/).filter(Boolean));
    const newWords = b.split(/\s+/).filter(Boolean).filter(w => !known.has(w));
    if (newWords.some(w => SIGNIFICANT_TERMS.has(w))) return 'domain_term_added';
    return 'question_type_flip';
  }
  if (cls === 'MEANINGFUL') {
    if (/[?？]/.test(b) && !/[?？]/.test(a)) return 'question_mark_added';
    return 'content_expanded';
  }
  return 'filler_only';
}

// Maps a raw boundary decision to the diagnostic label + reason.
function boundaryDecisionInfo(a, text, decision) {
  const hasQM = /[?？]/.test(String(text));
  let label;
  if (decision === 'finalize') label = 'FINALIZE';
  else if (decision === 'soft') label = 'CONTINUE';
  else label = 'WAIT_FOR_MORE';
  let reason;
  if (decision === 'finalize') reason = hasQM ? 'question_mark_confident' : 'score_confident';
  else if (decision === 'soft') reason = hasQM ? 'question_mark_soft' : 'moderate_confidence';
  else if (a.isIncomplete) reason = 'incomplete_question';
  else if (!a.isQuestion) reason = 'not_a_question';
  else reason = 'low_score';
  return { label: label, reason: reason };
}

// A lone short follow-up ("Why?", "What about?", "And then what?") only counts
// as a complete turn when there is prior conversation context. Without context
// these fragments are treated as normal (incomplete) speech.
function isShortFollowup(text, hasContext) {
  return !!hasContext && /^\s*(and\s+)?(why|what about|what if|how about|then what|what was the result|what happened)\??\s*$/i.test(String(text || '').trim());
}

// Transcript normalization (section 7): trim, collapse whitespace,
// collapse an immediately-repeated word so "the the" -> "the". Technical
// terminology is preserved verbatim; the renderer HTML-escapes before DOM.
function normalizeTranscript(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/\b(\w+)(\s+\1){1,2}\b/gi, '$1')
    .trim();
}

function sameUtterance(prev, next) {
  if (!prev || !next) return false;
  const a = String(prev).trim();
  const b = String(next).trim();
  if (b.startsWith(a) || a.startsWith(b)) return true;
  const as = new Set(a.toLowerCase().split(/\s+/));
  const bs = new Set(b.toLowerCase().split(/\s+/));
  let overlap = 0;
  as.forEach(w => { if (bs.has(w)) overlap++; });
  const min = Math.min(as.size, bs.size);
  return min > 0 && overlap / min >= 0.5;
}

function classifyQuestionType(text, hasContext) {
  const t = ' ' + String(text || '').toLowerCase().trim() + ' ';
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);

  // A lone follow-up like "Why?" / "What about?" is a complete turn when we
  // already have conversation context (Phase 2 §19).
  if (isShortFollowup(text, hasContext)) {
    return { type: 'followup', isIncomplete: false };
  }

  let isIncomplete = words.length < 3;
  if (!/[?？]\s*$/.test(String(text))) {
    const lw = (words[words.length - 1] || '').replace(/[^a-z]/g, '');
    if (lw && INCOMPLETE_TRAILERS.includes(lw)) isIncomplete = true;
  }
  if (isIncomplete) return { type: 'incomplete', isIncomplete: true };

  if (/\bdifference between\b|\bvs\.?\b|versus|compare/.test(t)) return { type: 'comparison', isIncomplete: false };
  if (/have you worked|have you used|have you ever|your experience|worked with|experience with|have you built|have you implemented|did you build|did you use/.test(t)) return { type: 'experience', isIncomplete: false };
  if (/error handling|exception|debug|troubleshoot|failed|failure|broken|issue you faced|biggest problem/.test(t)) return { type: 'troubleshooting', isIncomplete: false };
  if (/project|your role|architecture|designed|built a|developed a|tell me about a|tell me about the project/.test(t)) return { type: 'project', isIncomplete: false };
  if (hasContext && /why did you choose|how did you|what happened|tell me more|explain further|and what|in what way|why would/.test(t)) return { type: 'followup', isIncomplete: false };
  if (/how would|what would|if you|imagine|scenario|million records|large volume|handle a large|how do you process|design a|approach/.test(t)) return { type: 'scenario', isIncomplete: false };
  if (/what is|what's|whats|define|what does|what are|explain what|explain the/.test(t)) return { type: 'conceptual', isIncomplete: false };
  if (/best practice|how do you|how should|should you/.test(t)) return { type: 'best-practice', isIncomplete: false };
  return { type: 'conceptual', isIncomplete: false };
}

function analyzeQuestion(text, opts) {
  const cfg = opts || {};
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lower = ' ' + String(text).toLowerCase() + ' ';
  let score = 0;
  if (QUESTION_STARTERS.some(s => lower.includes(s))) score += 50;
  if (/[?？]/.test(text)) score += 25;
  if (words.length >= 5) score += 8;
  if (words.length >= 10) score += 8;
  if (/batch|process|integration|api|error|fail|retry|atom|cloud|connect|perform|design|architecture|data|record|listener|build|implement|profile|project|queue|exception|rest|soap|parallel|volume|retry|monitor/.test(lower)) score += 8;
  const cls = classifyQuestionType(text, !!cfg.hasContext);
  const fastThreshold = cfg.fastThreshold != null ? cfg.fastThreshold : DEFAULT_CFG.fastThreshold;
  return {
    score: Math.min(100, score),
    isQuestion: score >= fastThreshold,
    isIncomplete: cls.isIncomplete,
    type: cls.type,
    words: words.length
  };
}

function parseJsonObject(str) {
  const cleaned = String(str).replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start > -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) { /* fall through */ }
  }
  const pick = (k) => {
    const m = cleaned.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"'));
    return m ? m[1] : '';
  };
  let candidates = [];
  const arrMatch = cleaned.match(/"candidates"\s*:\s*(\[[\s\S]*?\])/);
  if (arrMatch) {
    try { candidates = JSON.parse(arrMatch[1]); } catch (_) { /* keep empty */ }
  }
  return { topic: pick('topic'), type: pick('type'), direction: pick('direction'), hint: pick('hint'), candidates };
}

function toConfidence(v) {
  const s = String(v || '').toUpperCase();
  if (s.includes('HIGH')) return 'HIGH';
  if (s.includes('MED') || s.includes('MID')) return 'MEDIUM';
  if (s.includes('LOW')) return 'LOW';
  return 'MEDIUM';
}

// ------------------------------------------------------------
// InterviewEngine
// ------------------------------------------------------------

class InterviewEngine {
  constructor(opts) {
    opts = opts || {};
    this.cfg = Object.assign({}, DEFAULT_CFG, opts.cfg || {});
    this.domain = opts.domain || this.cfg.domain;
    this.domainConfig = getDomainConfig(this.domain);
    this.knowledgeBase = opts.knowledgeBase || this.domainConfig.knowledge_base || DOMAIN_KB[this.domain] || DOMAIN_KB.Boomi;
    // Phase 4 — flexible file-based grounding from knowledge/resume.md +
    // knowledge/job-description.md (empty string when files are absent).
    this.candidateContext = opts.candidateContext !== undefined ? opts.candidateContext : loadCandidateContext();
    // Phase 7 — Master Scenario Bank from knowledge/scenarios.json (overridable
    // via opts.scenarioBank for deterministic tests).
    this.scenarioBank = opts.scenarioBank !== undefined ? opts.scenarioBank : loadScenarios();
    // Phase 4.5 — Dual-Mode Output. 'script' (natural spoken sentences,
    // read aloud) or 'architect' (ultra-concise bullet points for direction).
    this.outputMode = opts.outputMode || 'script'; // 'script' | 'architect'
    // Phase 5 — Latency Masker & Instant Opener. On by default; disabled via
    // opts.openersEnabled === false so deterministic tests can assert on the
    // exact API text (the opener is selected at random).
    this.openersEnabled = opts.openersEnabled !== false;
    // Phase 10 foundation — Candidate Response Analysis master lock. Default
    // OFF; the UI toggles it (Alt+V / toggle-mic) and future analysis logic
    // will only execute when this flag is true.
    this.candidateAnalysisEnabled = false;
    // Phase 10 Part 1 — Candidate Audio Capture: rolling accumulation of the
    // candidate's own spoken answer (from the physical microphone). Fed by
    // handleCandidateText(); only appended while candidateAnalysisEnabled.
    this.candidateTranscript = '';
    // Linguistic Locking: transcript final words that make a sentence
    // grammatically incomplete (prepositions / connectors) -> never finalize.
    this.incompleteHooks = this.domainConfig.incomplete_hooks || [];

    this.log = typeof opts.log === 'function' ? opts.log : function () {};
    this.onState = typeof opts.onState === 'function' ? opts.onState : null;
    this.onHint = typeof opts.onHint === 'function' ? opts.onHint : null;
    this.onAnswer = typeof opts.onAnswer === 'function' ? opts.onAnswer : null;
    this.onCandidates = typeof opts.onCandidates === 'function' ? opts.onCandidates : null;
    this.fastPathCall = typeof opts.fastPathCall === 'function' ? opts.fastPathCall : null;
    this.answerCall = typeof opts.answerCall === 'function' ? opts.answerCall : null;
    // Phase 10 Part 2 — the grader's API hook. Defaults to answerCall so the
    // renderer wiring needs no extra plumbing; tests may inject a dedicated call.
    this.apiCall = typeof opts.apiCall === 'function' ? opts.apiCall : this.answerCall;
    this.diag = typeof opts.diag === 'function' ? opts.diag : null;

    const root = (typeof window !== 'undefined') ? window : globalThis;
    // Bind timers/clock so detached calls (renderer: window.setTimeout etc.)
    // never throw "Illegal invocation" when invoked as this._timeoutFn().
    this._timeoutFn = typeof opts.timeoutFn === 'function' ? opts.timeoutFn : root.setTimeout.bind(root);
    this._clearTimeoutFn = typeof opts.clearTimeoutFn === 'function' ? opts.clearTimeoutFn : root.clearTimeout.bind(root);
    this._now = typeof opts.nowFn === 'function' ? opts.nowFn : Date.now.bind(Date);

    this.timers = {};

    this.state = STATES.IDLE;
    this.paused = false;
    this.phase = 'building'; // 'building' | 'answered'

    // transcript buffers
    this.latestInterim = '';
    this.finalSegments = [];
    this.questionBuffer = '';
    this.prevQuestion = '';
    this.prevAnswer = '';

    // analysis state
    this.confidence = 0;
    this.isIncomplete = false;
    this.type = 'unknown';
    this.topic = '';
    this.direction = '';
    this.hint = '';
    this.draftAnswer = '';
    this.currentAnswer = '';
    this.lastFinalizedText = '';

    // 3-tier question candidates (section 11-13)
    this.candidates = [];
    this.primary = null;

    // speech / pause bookkeeping
    this.lastSpeechAt = 0;
    this.boundaryHandled = false;
    this.snapshotNo = 0;
    this.draftStatus = 'none'; // 'none' | 'inflight' | 'done'
    this.draftSnapshot = -1;
    this.promotePending = 0;

    // --- Question/Turn Intelligence (Phase 2) ---
    // Latest immutable question snapshot for the CURRENT turn (created at a
    // likely/confirmed boundary). previousSnapshot preserves the prior turn's
    // snapshot so a new turn never destroys the old one (§21 / §25).
    this.lastSpeechFinal = false;   // whether the last boundary signal was speech_final
    this.lastSignal = null;         // 'speech_final' | 'utterance_end' | null
    this.lastSemanticClass = 'MINOR';
    this.lastSnapshot = null;
    this.previousSnapshot = null;
    this.turnSnapshots = [];        // bounded archive (maxSnapshots)

    // request control (section 15 / 25 / 30)
    this.seq = 0;
    this.fastReqId = 0;
    this.draftReqId = 0;
    this.finalReqId = 0;
    this.regenReqId = 0;
    this.supersedeDraftAt = 0;
    this.regenInFlight = false;

    // rate control (sentinel so the FIRST call uses the debounce, not the min-interval floor)
    this.lastFastAt = -1e12;
    this.lastDraftAt = -1e12;
    this.prevFastText = '';
    this.prevDraftText = '';

    this.utteranceNo = 0;
    this.turnId = '';
    this.lastTurnId = '';
    this.contextHistory = [];
    // Phase 6 — Extended Conversation Memory. Rolling {role, content} exchange
    // log injected into the Groq messages right before the current user prompt.
    // Kept to the last 4 turns (8 messages) to prevent context bloat.
    this.conversationHistory = [];

    // --- diagnostic observability (Phase 2A) ---
    this.pauseActive = false;
    this.pauseStartAt = 0;
    this.turnStartedAt = 0;
  }

  // ---------------- public API ----------------

  start() {
    if (this.paused) return;
    if (this.state === STATES.LISTENING) return;
    this._setState(STATES.LISTENING, 'engine_start');
    this._emitLog('ENGINE', 'engine started', { at: Date.now() });
  }

  processTranscript(raw, isFinal, speechFinal) {
    const text = normalizeTranscript(raw);
    if (!text) return;
    if (this.paused) return; // no new AI processing while paused
    const now = this._now();
    const gapMs = this.lastSpeechAt ? now - this.lastSpeechAt : 0;
    this.lastSpeechAt = now;
    this._emitLog(isFinal ? 'FINAL_TRANSCRIPT' : 'INTERIM_TRANSCRIPT', text, { words: wordCount(text) });
    this._pendingSpeechFinal = !!speechFinal;

    if (this.pauseActive) {
      this.pauseActive = false;
      this._diag('PAUSE_ENDED', {
        pauseDurationMs: this._now() - this.pauseStartAt,
        currentTranscript: text,
        currentTurnId: this.turnId
      });
    }

    // ignore ultra-short fragments — but a lone follow-up ("Why?") is a valid
    // turn when conversation context exists (Phase 2 §19)
    if (wordCount(text) < this.cfg.ignoreShortWords && !isShortFollowup(text, this.contextHistory.length > 0)) return;

    if (text === this.questionBuffer) return; // exact duplicate — nothing new

    if (this.phase === 'answered' && this._isDuplicateOfFinal(text)) return;

    // Phase 2 §14: classify the change so state updates match its weight
    // (MINOR -> nothing expensive; MEANINGFUL -> refresh state; MAJOR -> strengthen).
    const prevSemantic = this.lastSemanticClass;
    const prevType = this.type;
    const nextType = this._analyze(text).type;
    this.lastSemanticClass = classifySemanticChange(this.questionBuffer, text, prevType, nextType);
    if (this.lastSemanticClass !== 'MINOR') {
      this._diag('SEMANTIC_CHANGE', {
        previousText: this.questionBuffer,
        newText: text,
        previousSemanticClass: prevSemantic,
        newSemanticClass: this.lastSemanticClass,
        questionTypeBefore: prevType,
        questionTypeAfter: nextType,
        reason: semanticChangeReason(this.questionBuffer, text, this.lastSemanticClass, prevType, nextType)
      });
    }

    const same = sameUtterance(this.questionBuffer, text);
    const continuation = this.phase !== 'answered' && this.questionBuffer &&
      (same || (gapMs < this.cfg.continueWindowMs && !this._looksLikeFreshTurn(text)));
    if (!continuation) {
      this._beginUtterance(text, isFinal, this._pendingSpeechFinal);
    } else {
      this._continueUtterance(text, isFinal, this._pendingSpeechFinal);
    }
  }

  // Strong speech-boundary signal from Deepgram (speech_final=true on a
  // Results message, or an explicit UtteranceEnd event). Drives the
  // decision immediately instead of waiting for the watchdog.
  handleSpeechBoundary(signal) {
    if (this.paused) return;
    if (!this.questionBuffer) return;
    const silenceMs = this._now() - this.lastSpeechAt;
    this.lastSignal = signal || 'speech_final';
    this.lastSpeechFinal = this.lastSignal === 'speech_final';
    this._emitLog('SPEECH_BOUNDARY', signal || 'speech_final', { silenceMs, turnId: this.turnId, state: this.state });
    if (this.pauseActive) {
      this.pauseActive = false;
      this._diag('PAUSE_ENDED', {
        pauseDurationMs: silenceMs,
        currentTranscript: this.questionBuffer,
        currentTurnId: this.turnId,
        reason: 'speech_boundary'
      });
    }
    this._diag(signal === 'utterance_end' ? 'UTTERANCE_END' : 'SPEECH_FINAL', {
      silenceMs: silenceMs,
      transcript: this.questionBuffer
    });
    this._clearTimer('pause');
    this._onBoundary(silenceMs);
  }

  clear() {
    const clearedState = this.state;
    this._diag('CLEAR', {
      currentTurnId: this.turnId,
      currentQuestionState: clearedState,
      snapshotExisted: !!this.lastSnapshot,
      snapshotNo: this.lastSnapshot ? this.lastSnapshot.snapshotNo : null
    });
    this._clearAllTimers();
    this._invalidateInFlight();
    this.questionBuffer = '';
    this.latestInterim = '';
    this.finalSegments = [];
    this.draftAnswer = '';
    this.currentAnswer = '';
    this.lastFinalizedText = '';
    this.prevFastText = '';
    this.prevDraftText = '';
    this.type = 'unknown';
    this.topic = '';
    this.direction = '';
    this.hint = '';
    this.confidence = 0;
    this.isIncomplete = false;
    this.phase = 'building';
    this.regenInFlight = false;
    this.candidates = [];
    this.primary = null;
    this.promotePending = 0;
    this.draftStatus = 'none';
    this.draftSnapshot = -1;
    this.boundaryHandled = false;
    this.lastSpeechAt = 0;
    // Phase 2 §26: clear invalidates the CURRENT turn only; the archival
    // snapshot history (previous turns) is preserved.
    this.lastSnapshot = null;
    this.lastSignal = null;
    this.lastSpeechFinal = false;
    this.lastSemanticClass = 'MINOR';
    this.pauseActive = false;
    this._setState(this.paused ? STATES.PAUSED : STATES.LISTENING, 'user_clear');
    if (this.onAnswer) this.onAnswer({ text: '', provisional: false, state: this.state });
    if (this.onHint) this.onHint('');
    if (this.onCandidates) this.onCandidates([]);
    this._emitLog('CLEAR', 'display + question buffer cleared', { at: Date.now() });
  }

  pause() {
    if (this.paused) return;
    this._diag('PAUSE', { currentTurnId: this.turnId, questionState: this.state });
    this.pauseActive = false;
    this.paused = true;
    this._clearAllTimers();
    this._invalidateInFlight();
    this.questionBuffer = '';
    this.latestInterim = '';
    this.phase = 'building';
    this.promotePending = 0;
    this.draftStatus = 'none';
    this.draftSnapshot = -1;
    this.boundaryHandled = false;
    this.lastSpeechAt = 0;
    // Phase 2 §27: pausing must not produce new snapshots and the current
    // turn's live state is dropped; on resume the pipeline starts fresh.
    this.lastSnapshot = null;
    this.lastSignal = null;
    this.lastSpeechFinal = false;
    this.lastSemanticClass = 'MINOR';
    this._setState(STATES.PAUSED, 'user_pause');
    this._emitLog('PAUSE', 'listening paused', { at: Date.now() });
  }

  resume() {
    if (!this.paused) return;
    this._diag('RESUME', { currentTurnId: this.turnId, questionState: this.state });
    this.paused = false;
    // do not replay stale transcript; questionBuffer was cleared on pause
    this._setState(STATES.LISTENING, 'user_resume');
    this._emitLog('RESUME', 'listening resumed', { at: Date.now() });
  }

  async regenerate() {
    if (this.paused) { this._emitLog('REGEN', 'ignored while paused'); return; }
    if (this.regenInFlight) { this._emitLog('REGEN', 'ignored duplicate regenerate (already in flight)'); return; }
    const text = this.questionBuffer ||
      (this.contextHistory.length ? this.contextHistory[this.contextHistory.length - 1].q : '');
    if (!text) { this._emitLog('REGEN', 'no question to regenerate'); return; }

    this.regenInFlight = true;
    const reqId = ++this.seq;
    this.finalReqId = reqId;
    this.supersedeDraftAt = reqId;
    const startedAt = this._now();
    this._setState(STATES.ANSWERING, 'regenerate_requested');
    this._emitLog('ANSWER_REQUEST_STARTED', `regenerate req#${reqId}`, { q: text, turnId: this.turnId });
    try {
      const content = await this._callAnswer(text, 'final', (chunk) => {
        if (reqId === this.finalReqId && chunk && this.onAnswer) {
          this.onAnswer({ text: chunk, provisional: true, streaming: true, state: STATES.ANSWERING });
        }
      });
      const latency = this._now() - startedAt;
      if (reqId !== this.finalReqId) {
        this._emitLog('STALE_RESPONSE_REJECTED', `regen req#${reqId}`, { latency });
        this._diag('STALE_RESPONSE_REJECTED', { requestId: reqId, requestType: 'regenerate', latencyMs: latency });
        return;
      }
      const answer = (content || '').trim();
      if (answer) {
        this.currentAnswer = answer;
        const last = this.contextHistory[this.contextHistory.length - 1];
        if (last && last.q === text) last.a = answer;
        this._setState(STATES.ANSWER_READY, 'regenerate_complete');
        if (this.onAnswer) this.onAnswer({ text: answer, provisional: false, state: STATES.ANSWER_READY });
        this._scheduleIdle();
      }
      this._emitLog('ANSWER_REQUEST_COMPLETED', `regenerate req#${reqId}`, { latency, words: wordCount(answer) });
    } catch (err) {
      this._emitLog('API_ERROR', `regenerate req#${reqId} failed: ${err.message}`);
      this._diag('ERROR', { error: String(err && err.message || err), context: 'regenerate' });
      // keep the existing valid answer if there is one
      this._setState(this.currentAnswer ? STATES.ANSWER_READY : STATES.ERROR, 'api_error');
    } finally {
      this.regenInFlight = false;
    }
  }

  // ---------------- internals ----------------

  _setState(state, reason) {
    if (this.state === state) return;
    const from = this.state;
    this.state = state;
    this._emitLog('QUESTION_STATE_CHANGED', state, { at: Date.now(), turnId: this.turnId });
    this._diag('QUESTION_STATE_CHANGED', { from: from, to: state, reason: reason || '' });
    if (this.onState) this.onState(state);
  }

  _emitLog(tag, msg, data) {
    try { this.log(tag, msg, data); } catch (_) { /* logging must never break the pipeline */ }
  }

  // Phase 2A: structured diagnostic event. Never throws, never blocks.
  _diag(eventType, data) {
    if (!this.diag) return;
    try {
      this.diag(eventType, Object.assign({
        turnId: this.turnId || '',
        previousTurnId: this.lastTurnId || '',
        questionState: this.state
      }, data || {}));
    } catch (_) { /* diagnostics must never break the pipeline */ }
  }

  _setTimer(key, fn, ms) {
    this._clearTimer(key);
    const id = this._timeoutFn(fn, ms);
    this.timers[key] = id;
    if (['pause', 'idle', 'waitIdle'].includes(key)) {
      this._diag('TIMER_STARTED', { timer: key, delayMs: ms });
    }
    return id;
  }

  _clearTimer(key) {
    if (this.timers[key] != null) {
      try { this._clearTimeoutFn(this.timers[key]); } catch (_) { /* ignore */ }
      if (['pause', 'idle', 'waitIdle'].includes(key)) {
        this._diag('TIMER_CANCELLED', { timer: key });
      }
      delete this.timers[key];
    }
  }

  _clearAllTimers() {
    Object.keys(this.timers).forEach(k => this._clearTimer(k));
  }

  _invalidateInFlight() {
    this.seq += 1; // any in-flight request's id is now < seq and cannot match -1
    this.fastReqId = -1;
    this.draftReqId = -1;
    this.finalReqId = -1;
    this.regenReqId = -1;
    this.supersedeDraftAt = 0;
  }

  _isDuplicateOfFinal(text) {
    if (text === this.lastFinalizedText) return true;
    if (!this.lastFinalizedText) return false;
    // same set of words with no new info => duplicate re-send / punctuation change
    return wordDelta(this.lastFinalizedText, text) === 0;
  }

  _analyze(text) {
    return analyzeQuestion(text, {
      hasContext: this.contextHistory.length > 0,
      fastThreshold: this.cfg.fastThreshold
    });
  }

  _setQuestionInfo(a) {
    this.confidence = a.score;
    this.isIncomplete = a.isIncomplete;
    this.type = a.type;
  }

  _beginUtterance(text, isFinal, speechFinal) {
    this._clearAllTimers();
    this._invalidateInFlight();
    this.utteranceNo += 1;
    // Phase 2 §25: a NEW turn must not destroy the previous turn's state.
    // Archive the prior snapshot/turn before moving on.
    const archivedTurnId = this.turnId;
    const archivedSnapshotNo = this.lastSnapshot ? this.lastSnapshot.snapshotNo : null;
    if (archivedTurnId) {
      if (this.lastSnapshot) this.previousSnapshot = this.lastSnapshot;
      this.lastTurnId = archivedTurnId;
      this._emitLog('TURN_ARCHIVED', `previous turn ${archivedTurnId} preserved`, {
        previousTurnId: archivedTurnId, snapshotNo: archivedSnapshotNo
      });
    }
    this.turnId = 'turn_' + String(this.utteranceNo).padStart(3, '0');
    if (archivedTurnId) {
      this._diag('TURN_ARCHIVED', {
        archivedTurnId: archivedTurnId,
        newTurnId: this.turnId,
        snapshotNo: archivedSnapshotNo
      });
    }
    this.questionBuffer = text;
    this.latestInterim = isFinal ? '' : text;
    this.prevFastText = '';
    this.prevDraftText = '';
    this.phase = 'building';
    this.lastFinalizedText = '';
    this.draftAnswer = '';
    this.draftStatus = 'none';
    this.draftSnapshot = -1;
    this.promotePending = 0;
    this.boundaryHandled = false;
    this.candidates = [];
    this.primary = null;
    this.snapshotNo += 1;
    // new turn -> fresh signal/snapshot state (previous snapshot was archived above)
    this.lastSignal = null;
    this.lastSpeechFinal = false;
    this.lastSemanticClass = this.lastSemanticClass || 'MAJOR';
    this.lastSpeechAt = this._now();
    this.turnStartedAt = this._now();
    this._cancelIdle();
    const a = this._analyze(text);
    this._setQuestionInfo(a);
    this._diag('TURN_STARTED', {
      turnId: this.turnId,
      previousTurnId: this.lastTurnId || '',
      reason: 'new_utterance',
      initialTranscript: text
    });
    if (a.type === 'followup' && isShortFollowup(text, this.contextHistory.length > 0)) {
      this._diag('FOLLOWUP_DETECTED', {
        transcript: text,
        previousTurnId: this.lastTurnId || '',
        currentTurnId: this.turnId,
        hasContext: this.contextHistory.length > 0,
        reason: 'short_followup_utterance'
      });
    }
    this._diag('TRANSCRIPT_BUFFER_UPDATED', {
      previousBuffer: '',
      newBuffer: text,
      changeType: 'NEW_TURN'
    });
    this._diag(isFinal ? 'TRANSCRIPT_FINAL' : 'TRANSCRIPT_INTERIM', {
      transcript: text,
      transcriptLength: text.length,
      wordCount: wordCount(text),
      isInterim: !isFinal,
      deepgramIsFinal: !!isFinal,
      deepgramSpeechFinal: !!speechFinal
    });
    this._emitLog('QUESTION_UPDATED', `utterance #${this.utteranceNo}`, {
      text, confidence: a.score, incomplete: a.isIncomplete, type: a.type, turnId: this.turnId
    });
    this._applyTranscriptState(a);
    this._schedulePauseWatchdog();
  }

  _continueUtterance(text, isFinal, speechFinal) {
    const prevText = this.questionBuffer;
    const merged = this._mergeTranscript(prevText, text);
    const delta = wordDelta(prevText, merged);
    this.questionBuffer = merged;
    this.latestInterim = isFinal ? '' : merged;
    if (delta > 0) {
      this.snapshotNo += 1;
      this.boundaryHandled = false;   // speaker continued -> previous boundary no longer definitive
      this.promotePending = 0;
    }
    if (delta > 0 && this.lastSemanticClass !== 'MINOR') {
      this._diag('TRANSCRIPT_BUFFER_UPDATED', {
        previousBuffer: prevText,
        newBuffer: merged,
        changeType: this.lastSemanticClass
      });
    }
    if (delta > 0) {
      this._diag(isFinal ? 'TRANSCRIPT_FINAL' : 'TRANSCRIPT_INTERIM', {
        transcript: merged,
        transcriptLength: merged.length,
        wordCount: wordCount(merged),
        isInterim: !isFinal,
        deepgramIsFinal: !!isFinal,
        deepgramSpeechFinal: !!speechFinal
      });
    }
    const a = this._analyze(merged);
    this._setQuestionInfo(a);
    this._emitLog('QUESTION_UPDATED', 'utterance continuation', {
      confidence: a.score, incomplete: a.isIncomplete, type: a.type, delta, turnId: this.turnId
    });
    this._applyTranscriptState(a);
    this._schedulePauseWatchdog();
  }

  // Fragmentation fix: when a speaker pauses mid-question ("What is the
  // difference between" + "an atom and molecule") the follow-up fragment must
  // be appended to the existing buffer rather than starting a broken new turn.
  _mergeTranscript(prev, next) {
    const a = String(prev || '').trim();
    const b = String(next || '').trim();
    if (!a) return b;
    if (!b) return a;
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (bl.startsWith(al) || al.startsWith(bl)) return b; // streaming superset/prefix: latest wins
    const known = new Set(al.split(/\s+/).filter(Boolean));
    const newWords = b.split(/\s+/).filter(w => w && !known.has(w.toLowerCase()));
    if (!newWords.length) return a;
    return normalizeTranscript(a + ' ' + newWords.join(' '));
  }

  // A fragment that opens with a question starter ("how would...", "why...")
  // is a fresh turn, not a continuation of the previous question.
  _looksLikeFreshTurn(text) {
    const t = String(text || '').trim().toLowerCase();
    return QUESTION_STARTERS.some(s => t.startsWith(s));
  }

  _applyTranscriptState(a) {
    if (a.isIncomplete) {
      this._setState(STATES.WAITING_FOR_MORE, 'question_incomplete');
      this._scheduleFastPath(); // still surface a broad "likely area" (section 21)
      return;
    }
    // short follow-ups ("Why?") are legitimate complete turns even below the
    // min-words-for-question gate when conversation context exists
    const qualifies = a.words >= this.cfg.minWordsForQuestion ||
      (a.type === 'followup' && isShortFollowup(this.questionBuffer, this.contextHistory.length > 0));
    if (a.isQuestion && qualifies) {
      this._setState(a.type === 'followup' ? STATES.FOLLOW_UP : STATES.QUESTION_BUILDING, 'new_meaningful_transcript');
      this._scheduleFastPath();
      if (a.score >= this.cfg.draftThreshold) this._scheduleDraft(true);
    } else {
      this._setState(STATES.SPEECH_ACTIVE, 'speech_not_question');
    }
  }

  // ---------------- silence / pause watchdog ----------------

  _schedulePauseWatchdog() {
    if (this.paused) return;
    if (this.lastSpeechAt == null) return;
    const now = this._now();
    const silence = now - this.lastSpeechAt;
    const { pausePossibleMs, pauseLikelyMs, pauseBoundaryMs } = this.cfg;
    let target = null;
    if (silence < pausePossibleMs) target = pausePossibleMs - silence;
    else if (silence < pauseLikelyMs) target = pauseLikelyMs - silence;
    else if (silence < pauseBoundaryMs) target = pauseBoundaryMs - silence;
    else {
      this._clearTimer('pause');
      this._onBoundary(silence);
      return;
    }
    this._setTimer('pause', () => this._onPauseTick(), target);
  }

  _onPauseTick() {
    const now = this._now();
    const silence = now - this.lastSpeechAt;
    const { pausePossibleMs, pauseLikelyMs, pauseBoundaryMs } = this.cfg;
    if (silence >= pauseBoundaryMs) {
      this._clearTimer('pause');
      this._onBoundary(silence);
      return;
    }
    if (silence >= pauseLikelyMs) {
      this._onPauseLevel('likely');
    } else if (silence >= pausePossibleMs) {
      this._onPauseLevel('possible');
    }
    this._schedulePauseWatchdog();
  }

  _onPauseLevel(level) {
    const silence = this._now() - this.lastSpeechAt;
    if (level === 'possible') {
      if (!this.pauseActive) {
        this.pauseActive = true;
        this.pauseStartAt = this._now();
        this._diag('PAUSE_STARTED', {
          pauseStartElapsedMs: silence,
          currentTranscript: this.questionBuffer,
          currentTurnId: this.turnId,
          questionState: this.state
        });
      } else {
        this._diag('PAUSE_UPDATED', {
          pauseDurationMs: silence,
          checkpointMs: this.cfg.pausePossibleMs,
          currentTranscript: this.questionBuffer,
          questionState: this.state
        });
      }
      if ([STATES.QUESTION_BUILDING, STATES.SPEECH_ACTIVE, STATES.QUESTION_CANDIDATES_READY].includes(this.state)) {
        this._setState(STATES.PAUSE_DETECTED, 'pause_possible');
      }
    } else {
      this._diag('PAUSE_UPDATED', {
        pauseDurationMs: silence,
        checkpointMs: this.cfg.pauseLikelyMs,
        currentTranscript: this.questionBuffer,
        questionState: this.state
      });
      this._diag('BOUNDARY_CANDIDATE', {
        pauseDurationMs: silence,
        transcript: this.questionBuffer,
        questionType: this.type,
        semanticClass: this.lastSemanticClass,
        wordCount: wordCount(this.questionBuffer),
        completeness: this._analyze(this.questionBuffer).isIncomplete ? 'INCOMPLETE' : 'COMPLETE',
        state: this.state,
        reason: 'pause_threshold_reached'
      });
      if ([STATES.QUESTION_BUILDING, STATES.PAUSE_DETECTED, STATES.QUESTION_CANDIDATES_READY].includes(this.state)) {
        this._setState(STATES.QUESTION_BOUNDARY_LIKELY, 'pause_threshold_700ms');
      }
    }
    // NOTE: prep (fast/draft) is already scheduled when the transcript
    // arrived (_applyTranscriptState). Pause levels only refine STATE.
  }

  // ---------------- question boundary decision ----------------

  _onBoundary(silenceMs) {
    if (this.paused) return;
    if (this.boundaryHandled) return;
    if (this.phase === 'answered') return;
    const text = this.questionBuffer;
    if (!text) return;
    // short follow-ups ("Why?") are complete turns below the min-words gate
    // when conversation context exists (Phase 2 §19)
    const shortFollowup = isShortFollowup(text, this.contextHistory.length > 0);
    if (wordCount(text) < this.cfg.minWordsForQuestion && !shortFollowup) {
      this._diag('BOUNDARY_DECISION', {
        decision: 'WAIT_FOR_MORE',
        pauseDurationMs: silenceMs != null ? silenceMs : this._now() - this.lastSpeechAt,
        transcript: text,
        questionMark: false,
        wordCount: wordCount(text),
        questionType: 'incomplete',
        incomplete: true,
        score: 0,
        reason: 'too_few_words'
      });
      this._setState(STATES.WAITING_FOR_MORE, 'question_incomplete');
      return;
    }
    const a = this._analyze(text);
    const decision = this._boundaryDecision(a, text);
    const boundaryInfo = boundaryDecisionInfo(a, text, decision);
    const pauseMs = silenceMs != null ? silenceMs : this._now() - this.lastSpeechAt;
    this._diag('BOUNDARY_DECISION', {
      decision: boundaryInfo.label,
      pauseDurationMs: pauseMs,
      transcript: text,
      questionMark: /[?？]/.test(String(text)),
      wordCount: a.words,
      questionType: a.type,
      incomplete: a.isIncomplete,
      score: a.score,
      reason: boundaryInfo.reason
    });
    this._emitLog('QUESTION_BOUNDARY', decision, {
      silenceMs: pauseMs,
      turnId: this.turnId, score: a.score, words: a.words, state: this.state
    });
    if (decision === 'wait') {
      this.boundaryHandled = true;
      this._setState(STATES.WAITING_FOR_MORE, 'question_incomplete');
      // long silence with no useful direction -> back to listening
      this._setTimer('waitIdle', () => { if (!this.paused) this._setState(STATES.LISTENING, 'idle_wait_expired'); }, this.cfg.idleMs);
      return;
    }
    this.boundaryHandled = true;
    // Phase 2 §21: freeze an immutable snapshot of the completed question.
    // Capture the version BEFORE the increment so a draft that fired for this
    // exact question text (draftSnapshot) can be matched and promoted.
    const confirmedSnapshotNo = this.snapshotNo;
    this._createSnapshot(decision === 'finalize' ? 'finalize' : 'soft', text, a);
    if (this.draftStatus === 'done' && this.draftSnapshot === confirmedSnapshotNo && this.draftAnswer) {
      this._promoteDraftToFinal(this.draftAnswer);              // reuse the prepared draft
    } else if (this.draftStatus === 'inflight' && this.draftSnapshot === confirmedSnapshotNo) {
      this.promotePending = this.draftReqId;                    // wait for it, promote on resolve
      this._setState(STATES.ANSWERING, 'boundary_confirmed');
    } else {
      this._runFinalAnswer(decision === 'soft' ? 'soft' : 'final');
    }
  }

  _boundaryDecision(a, text) {
    const hasQM = /[?？]/.test(String(text));
    // Linguistic Locking: a transcript ending in a preposition or connector is
    // grammatically incomplete. Never finalize — not even on a long pause.
    const lastWord = String(text).trim().toLowerCase().split(/\s+/).filter(Boolean).pop() || '';
    const lastToken = lastWord.replace(/[^a-z0-9'’\-]/g, '');
    if (lastToken && (this.incompleteHooks || []).includes(lastToken)) return 'wait';
    if (a.isIncomplete) return 'wait';
    if (hasQM && a.words >= 4) return a.score >= this.cfg.confirmThreshold ? 'finalize' : 'soft';
    if (a.score >= this.cfg.confirmThreshold) return 'finalize';
    if (a.score >= this.cfg.autoAnswerThreshold) return 'soft';
    return 'wait';
  }

  // Phase 2 §21: freeze an immutable question snapshot. This is the interface
  // that Phase 3 (parallel retrieval / parallel API response engine) will
  // consume. The object is frozen so no later transcript event mutates it.
  _createSnapshot(decision, text, a) {
    const snap = Object.freeze({
      snapshotNo: ++this.snapshotNo,
      turnId: this.turnId,
      transcript: text,
      timestamp: this._now(),
      questionState: decision === 'finalize' ? 'QUESTION_COMPLETE' : 'QUESTION_BOUNDARY_LIKELY',
      isInterim: this.latestInterim !== '',
      isFinal: this.latestInterim === '',
      speechFinal: this.lastSpeechFinal,
      previousTurnId: this.lastTurnId || '',
      decision,
      score: a ? a.score : this.confidence,
      type: a ? a.type : this.type,
      semanticClass: this.lastSemanticClass,
      words: wordCount(text)
    });
    this.lastSnapshot = snap;
    // bound the archive so an hour-long interview cannot grow memory without control
    this.turnSnapshots.push(snap);
    if (this.turnSnapshots.length > this.cfg.maxSnapshots) this.turnSnapshots.shift();
    this._emitLog('QUESTION_SNAPSHOT_CREATED', `snapshot#${snap.snapshotNo}`, {
      turnId: snap.turnId, transcript: snap.transcript, decision: snap.decision,
      state: snap.questionState, speechFinal: snap.speechFinal, previousTurnId: snap.previousTurnId
    });
    this._diag('QUESTION_SNAPSHOT_CREATED', {
      snapshotNo: snap.snapshotNo,
      turnId: snap.turnId,
      previousTurnId: snap.previousTurnId,
      transcript: snap.transcript,
      timestamp: snap.timestamp,
      questionState: snap.questionState,
      isInterim: snap.isInterim,
      isFinal: snap.isFinal,
      speechFinal: snap.speechFinal,
      decision: snap.decision,
      score: snap.score,
      type: snap.type,
      semanticClass: snap.semanticClass,
      words: snap.words
    });
    return snap;
  }

  getLatestSnapshot() {
    return this.lastSnapshot;
  }

  // Phase 4.5 — Dual-Mode Output: flip between 'script' (spoken sentences)
  // and 'architect' (concise bullet points). Returns the new mode.
  toggleOutputMode() {
    this.outputMode = this.outputMode === 'script' ? 'architect' : 'script';
    return this.outputMode;
  }

  // Phase 10 Part 1 — Candidate Audio Capture: append the candidate's own
  // spoken transcript. A no-op unless the master lock (Alt+V) is enabled.
  handleCandidateText(text) {
    if (!this.candidateAnalysisEnabled) return;
    this.candidateTranscript += ' ' + String(text || '').trim();
  }

  // Phase 10 Part 2 — Candidate Response Analysis & Scoring: grade the
  // candidate's spoken answer against the expected (last suggested) answer.
  // Returns null when there is nothing to grade or the grader fails, and always
  // clears the transcript buffer after a grading attempt.
  async analyzeCandidateResponse() {
    if (!this.candidateTranscript || this.candidateTranscript.trim().length === 0) return null;
    if (!this.apiCall) return null;

    // Get the last suggested answer from history
    const lastAssistantMessage = this.conversationHistory.slice().reverse().find(msg => msg.role === 'assistant');
    const expectedAnswer = lastAssistantMessage ? lastAssistantMessage.content : "N/A";

    const prompt = `You are an interview coach. Compare the candidate's spoken answer to the expected perfect answer.
Expected: "${expectedAnswer}"
Candidate Spoken: "${this.candidateTranscript}"

Return ONLY a valid JSON object with no markdown formatting:
{"accuracy": "X/10", "feedback": "1 short sentence of constructive feedback"}`;

    try {
      const response = await this.apiCall([{ role: 'system', content: prompt }], 'base', () => {});
      this.candidateTranscript = ''; // clear transcript after grading
      const cleaned = String(response).replace(/```json/gi, '').replace(/```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start > -1 && end > start) {
        return JSON.parse(cleaned.slice(start, end + 1));
      }
      return JSON.parse(cleaned);
    } catch (e) {
      console.error("Grader failed:", e);
      return null;
    }
  }

  getPreviousSnapshot() {
    return this.previousSnapshot;
  }

  getTurnSnapshots() {
    return this.turnSnapshots;
  }

  // ---------------- Fast Path (3-tier candidates) ----------------

  _scheduleFastPath() {
    // Phase 12 — Multi-Tier Router: in 'rag-only' mode no external API call is
    // allowed, including the fast-path classification tier.
    if (this.cfg.routerMode === 'rag-only') return;
    const now = this._now();
    const since = now - this.lastFastAt;
    const delta = wordDelta(this.prevFastText, this.questionBuffer);

    if (this.prevFastText && delta < this.cfg.minDeltaWords) return;

    if (since < this.cfg.fastMinIntervalMs) {
      if (delta >= this.cfg.minDeltaWords) {
        this._setTimer('fast', () => this._runFastPath(), Math.max(200, this.cfg.fastMinIntervalMs - since));
      }
      return;
    }
    this._setTimer('fast', () => this._runFastPath(), this.cfg.fastDebounceMs);
  }

  async _runFastPath() {
    const text = this.questionBuffer;
    this.prevFastText = text;
    const reqId = ++this.seq;
    this.fastReqId = reqId;
    const startedAt = this._now();
    this.lastFastAt = startedAt;
    this._emitLog('FAST_PATH_STARTED', `req#${reqId}`, { text, turnId: this.turnId });
    try {
      const content = await this._callFast(text);
      const latency = this._now() - startedAt;
      if (reqId !== this.fastReqId) {
        this._emitLog('STALE_RESPONSE_REJECTED', `fast-path req#${reqId}`, { latency });
        this._diag('STALE_RESPONSE_REJECTED', { requestId: reqId, requestType: 'fast_path', latencyMs: latency });
        return;
      }
      const info = parseJsonObject(content || '');
      this._applyFastInfo(info);
      this._emitLog('FAST_PATH_COMPLETED', `req#${reqId}`, {
        latency, topic: this.topic, type: this.type,
        candidates: this.candidates.map(c => `${c.priority}:${c.confidence}:${c.text}`), turnId: this.turnId
      });
    } catch (err) {
      this._emitLog('API_ERROR', `fast-path req#${reqId} failed: ${err.message}`);
      this._diag('ERROR', { error: String(err && err.message || err), context: 'fast_path', requestId: reqId });
      this._emitLog('FAST_PATH_COMPLETED', `req#${reqId} failed`);
      // no automatic retry — a later meaningful transcript triggers a clean retry
    }
  }

  _applyFastInfo(info) {
    if (info.candidates && Array.isArray(info.candidates)) {
      this.candidates = info.candidates
        .slice(0, this.cfg.maxCandidates)
        .map((c, i) => ({
          text: String(c.interpretation || c.q || c.topic || '').trim(),
          confidence: toConfidence(c.confidence),
          type: c.type || info.type || this.type || '',
          priority: i + 1
        }))
        .filter(c => c.text);
      this.primary = this.candidates[0] || null;
      if (this.onCandidates) this.onCandidates(this.candidates);
    }
    if (info.topic) this.topic = info.topic;
    if (info.type && info.type !== 'incomplete') this.type = info.type;
    if (info.direction) this.direction = info.direction;
    if (info.hint) {
      this.hint = info.hint;
      if (this.onHint) this.onHint(info.hint);
    } else if (this.primary) {
      this.hint = this._deriveHint();
      if (this.onHint) this.onHint(this.hint);
    }
    if (this.candidates.length && this.state === STATES.QUESTION_BUILDING) {
      this._setState(STATES.QUESTION_CANDIDATES_READY, 'candidates_ready');
    }
  }

  _deriveHint() {
    if (this.direction) {
      return this.direction
        .replace(/\band\b/gi, ',')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(' -> ');
    }
    const map = {
      conceptual: 'Definition -> Example -> Boomi context',
      scenario: 'Approach -> Trade-offs -> Outcome',
      experience: 'Context -> Action -> Result',
      project: 'Goal -> Role -> Outcome',
      troubleshooting: 'Diagnose -> Isolate -> Fix -> Verify',
      comparison: 'Difference -> Use cases -> Recommendation',
      'best-practice': 'Principle -> Example -> Pitfall',
      followup: 'Recall context -> Clarify -> Extend',
      incomplete: 'Listen for more...'
    };
    return map[this.primary ? this.primary.type : ''] || 'Key point -> Example -> Why it matters';
  }

  // ---------------- Background draft (promoted at boundary) ----------------

  _scheduleDraft(display) {
    if (this._analyze(this.questionBuffer).isIncomplete) return;
    const now = this._now();
    const since = now - this.lastDraftAt;
    const delta = wordDelta(this.prevDraftText, this.questionBuffer);

    if (this.prevDraftText && delta < this.cfg.minDeltaWords) return;

    if (since < this.cfg.draftMinIntervalMs) {
      if (delta >= this.cfg.minDeltaWords) {
        this._setTimer('draft', () => this._runDraft(display), Math.max(300, this.cfg.draftMinIntervalMs - since));
      }
      return;
    }
    this._setTimer('draft', () => this._runDraft(display), this.cfg.draftDebounceMs);
  }

  async _runDraft(display) {
    if (this.phase === 'answered' || this.finalReqId > 0) return; // a final already decided — draft is redundant
    const text = this.questionBuffer;
    this.prevDraftText = text;
    const reqId = ++this.seq;
    this.draftReqId = reqId;
    this.draftStatus = 'inflight';
    this.draftSnapshot = this.snapshotNo;
    this.draftAnswer = '';
    const startedAt = this._now();
    this.lastDraftAt = startedAt;
    this._emitLog('ANSWER_REQUEST_STARTED', `draft req#${reqId}`, { text, display, turnId: this.turnId });
    // Phase 7 — Scenario Interceptor: exact-match the Master Scenario Bank before
    // hitting Groq. On a hit, mark the draft done with the local answer so the
    // boundary promotes it instantly — no API call at all.
    // Phase 12 — Multi-Tier Router: in 'rag-only' mode a miss also marks the draft
    // done with the safe fallback — no external API is ever called.
    let localMatch = this._searchLocalScenarios(text);
    if (!localMatch && this.cfg.routerMode === 'rag-only') {
      localMatch = RAG_ONLY_FALLBACK;
    }
    if (localMatch) {
      const opener = this._pickOpener();
      this.draftAnswer = this.openersEnabled ? `${opener} ${localMatch}` : localMatch;
      this.draftStatus = 'done';
      this._emitLog('LOCAL_SCENARIO_INTERCEPT', `draft fast-path (no Groq)`, {
        turnId: this.turnId, latencyMs: this._now() - startedAt
      });
      return;
    }
    try {
      const content = await this._callAnswer(text, 'draft', (chunk) => {
        if (reqId !== this.draftReqId || reqId < this.supersedeDraftAt) return;
        if (display && chunk && this.onAnswer) {
          this.onAnswer({ text: chunk, provisional: true, streaming: true, state: this.state });
        }
      });
      const latency = this._now() - startedAt;
      if (reqId !== this.draftReqId || reqId < this.supersedeDraftAt) {
        this._emitLog('STALE_RESPONSE_REJECTED', `draft req#${reqId}`, { latency });
        this._diag('STALE_RESPONSE_REJECTED', { requestId: reqId, requestType: 'draft', latencyMs: latency });
        return;
      }
      const answer = (content || '').trim();
      this.draftAnswer = answer;
      if (this.promotePending === reqId) {
        this.promotePending = 0;
        this._promoteDraftToFinal(answer);
      } else {
        this.draftStatus = 'done';
        if (display && answer && this.onAnswer) {
          this.onAnswer({ text: answer, provisional: true, state: this.state });
        }
      }
      this._emitLog('ANSWER_REQUEST_COMPLETED', `draft req#${reqId}`, { latency, words: wordCount(answer) });
    } catch (err) {
      this._emitLog('API_ERROR', `draft req#${reqId} failed: ${err.message}`);
      this._diag('ERROR', { error: String(err && err.message || err), context: 'draft', requestId: reqId });
      if (this.promotePending === reqId) {
        this.promotePending = 0;
        this._setState(STATES.ERROR, 'api_error');
      }
    }
  }

  _promoteDraftToFinal(answer) {
    const text = this.questionBuffer;
    if (!answer) {
      this._runFinalAnswer('final');
      return;
    }
    this.currentAnswer = answer;
    this.lastFinalizedText = text;
    this.phase = 'answered';
    this.draftStatus = 'done';
    this.contextHistory.push({ q: text, a: answer, turnId: this.turnId });
    if (this.contextHistory.length > this.cfg.maxContextPairs) this.contextHistory.shift();
    // Phase 6 — Extended Conversation Memory + Confidence Scoring (same as the
    // _runFinalAnswer path: a promoted draft IS the final answer for the turn).
    let confidence = 'red';
    if (this.confidence >= 60) confidence = 'green';
    else if (this.confidence >= 35) confidence = 'yellow';
    if (answer) {
      this.conversationHistory.push({ role: 'user', content: text });
      this.conversationHistory.push({ role: 'assistant', content: answer });
      if (this.conversationHistory.length > 8) {
        this.conversationHistory = this.conversationHistory.slice(-8);
      }
    }
    this._setState(STATES.ANSWER_READY, 'draft_promoted');
    this._diag('TURN_COMPLETED', {
      turnId: this.turnId,
      transcript: text,
      durationMs: this.turnStartedAt ? this._now() - this.turnStartedAt : null,
      snapshotNo: this.lastSnapshot ? this.lastSnapshot.snapshotNo : this.snapshotNo,
      confidence
    });
    if (this.onAnswer) this.onAnswer({ text: answer, provisional: false, state: STATES.ANSWER_READY, confidence });
    this._scheduleIdle();
    this._emitLog('ANSWER_PROMOTED', 'draft promoted to final answer', { turnId: this.turnId, words: wordCount(answer) });
  }

  // ---------------- Final answer ----------------

  // Phase 7 — Local Scenario Interceptor. Exact keyword match against the Master
  // Scenario Bank (knowledge/scenarios.json). All keywords must be present in the
  // transcript; returns the canned answer string or null (falls through to Groq).
  _searchLocalScenarios(transcript) {
    if (!this.scenarioBank || this.scenarioBank.length === 0) return null;
    // Phase 12 — Multi-Tier Router: in 'agent-only' mode the local RAG layer is
    // disabled entirely; every question must go to the external LLM.
    if (this.cfg.routerMode === 'agent-only') return null;
    const lowerTranscript = transcript.toLowerCase();
    for (const scenario of this.scenarioBank) {
      // Phase 12 — Fuzzy match: >= 75% of the scenario's keywords present in the
      // transcript counts as a hit (was: all keywords required).
      const keywords = scenario.keywords || [];
      if (keywords.length === 0) continue;
      const present = keywords.filter(kw => lowerTranscript.includes(kw)).length;
      const overlap = present / keywords.length;
      if (overlap >= 0.75) return scenario.answer;
    }
    return null;
  }

  // Shared opener selection (Phase 5) so both the draft and final paths can
  // prepend the same type-matched conversational opener.
  _pickOpener() {
    const openers = this.openersEnabled
      ? (SAFE_OPENERS[this.type] || SAFE_OPENERS.fallback)
      : [''];
    return openers[Math.floor(Math.random() * openers.length)];
  }

  async _runFinalAnswer(mode) {
    const text = this.questionBuffer;
    if (!text) return;
    const reqId = ++this.seq;
    this.finalReqId = reqId;
    this.supersedeDraftAt = reqId; // a real final supersedes older drafts
    this._clearTimer('draft');     // the authoritative final cancels any still-pending draft
    const startedAt = this._now();
    // Phase 6 — Confidence Scoring. Maps the turn's question-score (0-100) to a
    // Green/Yellow/Red boundary-confidence indicator surfaced to the UI.
    let confidence = 'red';
    if (this.confidence >= 60) confidence = 'green';
    else if (this.confidence >= 35) confidence = 'yellow';
    // Phase 5 — Latency Masker: pick a type-matched safe opener and flash it
    // to the UI at 0ms so the candidate has something to say while Groq streams.
    const selectedOpener = this._pickOpener();
    if (this.openersEnabled && this.onAnswer) {
      this.onAnswer({ text: selectedOpener, provisional: true, streaming: true, state: STATES.ANSWERING, confidence });
    }
    this._setState(STATES.ANSWERING, 'final_answer_started');
    // Phase 7 — Scenario Interceptor: exact-match against the Master Scenario
    // Bank (knowledge/scenarios.json). On a hit, skip the Groq API entirely and
    // resolve instantly with the locally stored answer (sub-10ms fast-path).
    // Phase 12 — Multi-Tier Router: in 'rag-only' mode a miss also resolves
    // locally (with the safe fallback) — no external API is ever called.
    let localMatch = this._searchLocalScenarios(text);
    if (!localMatch && this.cfg.routerMode === 'rag-only') {
      localMatch = RAG_ONLY_FALLBACK;
    }
    if (localMatch) {
      const answer = this.openersEnabled ? `${selectedOpener} ${localMatch}` : localMatch;
      this.currentAnswer = answer;
      this.lastFinalizedText = text;
      this.phase = 'answered';
      this.contextHistory.push({ q: text, a: answer, turnId: this.turnId });
      if (this.contextHistory.length > this.cfg.maxContextPairs) this.contextHistory.shift();
      this.conversationHistory.push({ role: 'user', content: text });
      this.conversationHistory.push({ role: 'assistant', content: localMatch });
      if (this.conversationHistory.length > 8) this.conversationHistory = this.conversationHistory.slice(-8);
      this._setState(STATES.ANSWER_READY, 'local_scenario_intercept');
      this._diag('TURN_COMPLETED', {
        turnId: this.turnId,
        transcript: text,
        durationMs: this.turnStartedAt ? this._now() - this.turnStartedAt : null,
        snapshotNo: this.lastSnapshot ? this.lastSnapshot.snapshotNo : this.snapshotNo,
        confidence: 'green',
        source: localMatch === RAG_ONLY_FALLBACK ? 'rag-only-fallback' : 'local-scenario-bank'
      });
      this._emitLog('LOCAL_SCENARIO_INTERCEPT', `scenario fast-path (no Groq)`, {
        turnId: this.turnId, latencyMs: this._now() - startedAt, confidence: 'green'
      });
      if (this.onAnswer) this.onAnswer({ text: answer, provisional: false, state: STATES.ANSWER_READY, confidence: 'green' });
      this._scheduleIdle();
      return; // exit early — Groq API never called
    }
    this._emitLog('ANSWER_REQUEST_STARTED', `final req#${reqId}`, { text, turnId: this.turnId, confidence });
    try {
      const content = await this._callAnswer(text, mode || 'final', (chunk) => {
        if (reqId !== this.finalReqId) return;
        if (chunk && this.onAnswer) {
          this.onAnswer({ text: `${selectedOpener} ${chunk}`.trim(), provisional: true, streaming: true, state: STATES.ANSWERING, confidence });
        }
      });
      const latency = this._now() - startedAt;
      if (reqId !== this.finalReqId) {
        this._emitLog('STALE_RESPONSE_REJECTED', `final req#${reqId}`, { latency });
        this._diag('STALE_RESPONSE_REJECTED', { requestId: reqId, requestType: 'final', latencyMs: latency });
        return;
      }
      const apiAnswer = (content || '').trim();
      const answer = apiAnswer
        ? (this.openersEnabled ? `${selectedOpener} ${apiAnswer}` : apiAnswer)
        : (this.openersEnabled ? selectedOpener : '');
      if (answer) {
        this.currentAnswer = answer;
        this.lastFinalizedText = text;
        this.phase = 'answered';
        this.contextHistory.push({ q: text, a: answer, turnId: this.turnId });
        if (this.contextHistory.length > this.cfg.maxContextPairs) this.contextHistory.shift();
        // Phase 6 — Extended Conversation Memory: record the exchange, keep only
        // the last 4 turns (8 messages) to prevent context bloat.
        if (apiAnswer) {
          this.conversationHistory.push({ role: 'user', content: text });
          this.conversationHistory.push({ role: 'assistant', content: apiAnswer });
          if (this.conversationHistory.length > 8) {
            this.conversationHistory = this.conversationHistory.slice(-8);
          }
        }
        this._setState(STATES.ANSWER_READY, 'answer_complete');
        this._diag('TURN_COMPLETED', {
          turnId: this.turnId,
          transcript: text,
          durationMs: this.turnStartedAt ? this._now() - this.turnStartedAt : null,
          snapshotNo: this.lastSnapshot ? this.lastSnapshot.snapshotNo : this.snapshotNo,
          confidence
        });
        if (this.onAnswer) this.onAnswer({ text: answer, provisional: false, state: STATES.ANSWER_READY, confidence });
        this._scheduleIdle();
      }
      this._emitLog('ANSWER_REQUEST_COMPLETED', `final req#${reqId}`, { latency, words: wordCount(answer), confidence });
    } catch (err) {
      this._emitLog('API_ERROR', `final req#${reqId} failed: ${err.message}`);
      this._diag('ERROR', { error: String(err && err.message || err), context: 'final_answer', requestId: reqId });
      this._setState(STATES.ERROR, 'api_error');
      // Deepgram/audio continue; a later transcript update triggers a clean retry
    }
  }

  // ---------------- Idle + follow-up ----------------

  _scheduleIdle() {
    this._cancelIdle();
    this._setTimer('idle', () => {
      if (this.state === STATES.ANSWER_READY && !this.paused) {
        this._setState(STATES.LISTENING); // no meaningful speech for a while
      }
    }, this.cfg.idleMs);
  }

  _cancelIdle() {
    this._clearTimer('idle');
  }

  getFollowContext() {
    if (!this.contextHistory.length) return '';
    return this.contextHistory
      .map((p, i) => `Q${i + 1}: ${p.q} | A${i + 1}: ${p.a}`)
      .join(' ; ');
  }

  // ---------------- Prompts ----------------

  buildFastPrompt(text) {
    const fc = this.getFollowContext();
    return [
      {
        role: 'system',
        content: `You are a senior ${this.domain} technical interview coach analyzing a LIVE interviewer question. The transcript may be PARTIAL — the interviewer may still be speaking. Respond with STRICT JSON only (no markdown, no commentary) with exactly these keys: {"topic":"2-4 word topic","type":"conceptual|experience|project|scenario|troubleshooting|comparison|best-practice|followup|incomplete","direction":"one short sentence pointing the candidate at the useful angle","hint":"3-5 short concepts joined by ' -> ' summarizing the answer direction","candidates":[{"interpretation":"best-guess of the full question the interviewer is moving toward","confidence":"HIGH"},{"interpretation":"next most likely question","confidence":"MEDIUM"},{"interpretation":"broader fallback interpretation","confidence":"LOW"}]}. Candidates MUST be ordered from most to least likely and stay specific to the partial transcript. If the transcript is too incomplete to judge confidently, set type to "incomplete" and give broad but still useful candidates. Domain context: ${this.knowledgeBase}.${fc ? ` Earlier in this interview: ${fc}` : ''}`
      },
      { role: 'user', content: `(partial) Interviewer question: "${text}"` }
    ];
  }

  buildAnswerPrompt(text, mode) {
    const fc = this.getFollowContext();
    const type = this.type;
    const personal = ['experience', 'project', 'scenario', 'troubleshooting', 'followup'].includes(type);
    const dir = this.direction ? ` Suggested angle to cover: ${this.direction}.` : '';
    const ctx = fc ? ` Earlier in this interview, Q/A you may naturally reference: ${fc}.` : '';
    const candidateGrounding = this.candidateContext || '';
    // Phase 4.5 — Dual-Mode Output: the format rule depends on outputMode.
    const formatRule = this.outputMode === 'architect'
      ? "FORMAT RULE: Output ONLY 3-4 ultra-concise bullet points outlining the structural flow, architectural components, or steps. Use arrows (->) or short phrases. Do NOT use full conversational sentences."
      : "FORMAT RULE: Answer directly in 2-3 crisp, natural spoken sentences. Focus on the exact technical mechanism. Do not give generic definitions.";
    let modeNote;
    if (mode === 'draft') {
      modeNote = ' The interviewer is still speaking; this is a provisional early answer to prepare while they finish. Keep it tight and useful.';
    } else if (mode === 'soft') {
      modeNote = ' The transcript may be incomplete or ambiguous. Give a clear, general answer direction that stays useful regardless of the exact wording — do not invent specifics.';
    } else {
      modeNote = ' This is the final answer the candidate will read aloud in the interview.';
    }
    // Phase 5 — the conversational opener is handled LOCALLY (flashed at 0ms),
    // so the LLM must never generate its own pleasantries or double-openers.
    const noPleasantryRule = "CRITICAL RULE: Do NOT start your answer with pleasantries, greetings, or filler words (e.g., 'Certainly', 'Great question', 'In my experience'). Start immediately with the raw technical core of the answer, because a conversational opener has already been provided to the user.";
    return [
      {
        role: 'system',
        content: `You are a senior ${this.domain} integration developer in a live technical interview, and you are the CANDIDATE. Answer the interviewer's question exactly the way a real, experienced candidate would say it out loud. Speak in flowing, natural prose — no bullets, no markdown, no headings. ${personal
          ? 'Use first person ("I would...", "I typically...") as a candidate describing their own approach. For experience/project questions, describe what you would do in a natural, credible way.'
          : 'Give a crisp, direct technical explanation. Do not invent a personal story.'} ${formatRule} Never fabricate specific companies, exact numbers, or tools you are not sure about; if you lack the candidate's real experience, use a safe framing like "I would approach that by..." instead of inventing facts. Avoid filler openers such as "Certainly!", "Absolutely!", "In today's world", "There are several approaches", "It is important to note", or "As an AI". Question type: ${type}.${dir}${ctx}${modeNote} ${noPleasantryRule} ${candidateGrounding} STRICT RULE: You are the candidate described in CANDIDATE RESUME. Speak naturally in first person ('In my project, I implemented...', 'I usually approach this by...'). Highlight skills matching the TARGET JOB DESCRIPTION. NEVER invent or fabricate experience. If a topic is not in the candidate's resume, truthfully state 'I haven't worked with that directly, but my understanding is...' followed by a concise, accurate technical answer.`
      },
      { role: 'user', content: this._answerUserText(text) }
    ];
  }

  _answerUserText(text) {
    const base = 'Question: "' + text + '"';
    if (!this.primary) return base;
    if (this.primary.confidence === 'HIGH' || this.primary.confidence === 'MEDIUM') {
      return base + ' The interviewer appears to be asking about: "' + this.primary.text + '".';
    }
    return base + ' The question is not fully clear; give a useful general answer direction.';
  }

  _callFast(text) {
    if (!this.fastPathCall) return Promise.resolve('');
    return this.fastPathCall(this.buildFastPrompt(text));
  }

  _callAnswer(text, mode, onChunk) {
    if (!this.answerCall) return Promise.resolve('');
    const messages = this.buildAnswerPrompt(text, mode);
    // Phase 6 — inject the rolling conversation history right before the current
    // user prompt so the model answers with full interview memory (last 4 turns).
    if (this.conversationHistory.length > 0) {
      messages.splice(messages.length - 1, 0, ...this.conversationHistory);
    }
    return this.answerCall(messages, mode, onChunk);
  }
}

module.exports = {
  InterviewEngine,
  STATES,
  DEFAULT_CFG,
  DOMAIN_KB,
  analyzeQuestion,
  classifyQuestionType,
  parseJsonObject,
  normalizeTranscript,
  toConfidence,
  wordDelta,
  wordCount,
  sameUtterance,
  classifySemanticChange,
  semanticChangeReason,
  boundaryDecisionInfo,
  isShortFollowup
};