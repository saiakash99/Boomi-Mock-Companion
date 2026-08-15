# 📋 Boomi Companion Project Changelog

## [1.16.0] - Phase 12: Multi-Tier Model Split, Fuzzy Local RAG & Gemini Failover Router
- **`engine.js` — Multi-Tier Router (`routerMode`):** new `DEFAULT_CFG.routerMode` (`'hybrid'` default | `'rag-only'` | `'agent-only'`) and `fastModel: 'llama-3.1-8b-instant'` (answer tier stays `llama-3.3-70b-versatile`). `_searchLocalScenarios` returns `null` in `agent-only` mode; fuzzy-matches when **>= 75%** of a scenario's keywords are present (was: all keywords required). In `rag-only` mode, `_runFinalAnswer` / `_runDraft` never call an external API — a scenario miss resolves locally with the safe fallback *"I focus on Boomi integration architecture. Could you clarify your question?"* (and `_scheduleFastPath` is skipped too, so no API is hit anywhere).
- **`index.html` — Multi-Tier Model Split:** `callGroq` uses `llama-3.1-8b-instant` for the fast/JSON tier (`mode === true`) and `llama-3.3-70b-versatile` for the answer tier.
- **`index.html` — Gemini Failover Router:** new `callWithFallback` wraps every LLM path (`fastPathCall`, `answerCall`, `apiCall` now all route through it). Groq is attempted first with a **500ms time-to-first-token `AbortController`** timeout (cleared on the first streamed chunk); on an HTTP 429 or the TTFT abort it fails over to **Gemini 2.5 Flash** (`generateContent` for JSON, `streamGenerateContent` SSE for answers) using `process.env.GEMINI_API_KEY` (cached from `get-env`). No key / non-429-error → rethrows the original.
- Test Suite: **88 engine + 24 diagnostic + 9 audio-pipeline tests passing (121 total, 0 failed)** — 7 new engine tests (router defaults, agent-only null, 75% fuzzy hit, sub-75% no hit, rag-only fallback with zero API calls, rag-only still uses local matches, rag-only draft fallback).

## [1.15.0] - Phase 11: App Packaging (Electron Builder)
- **`package.json`:** `electron-builder` (`^26.15.3`) added as a dev dependency; new `"build": "electron-builder --win --x64"` script; root-level `"build"` config — `appId: com.boomiboss.interviewengine`, `productName: "Boomi Boss Engine"`, Windows `nsis` target (oneClick off, install-directory change allowed), output to `dist/`. `npm run build` now produces a clean Windows `.exe` installer for the full Core MVP + Phase 10 candidate analysis feature set.
- **Project is now READY FOR PRODUCTION** — packaging was the last remaining roadmap milestone (legacy Phase 4 #3 "Package the app into a clean .exe via Electron Builder" is complete; the legacy Phase 4 #1 DevTools-hide / #2 Alt+R regenerate were long since delivered in earlier phases).
- Test Suite: **unchanged at 114 (81 engine + 24 diagnostic + 9 audio-pipeline, 0 failed)** — packaging is a build-config change, no runtime behavior touched.

## [1.14.0] - Phase 10 Part 2: Candidate Response Analysis & Scorecard UI
- **`Alt+A` global hotkey** (Analyze) added in `main.js` → sends `analyze-candidate` to the renderer.
- **`engine.js`:** new `analyzeCandidateResponse()` grader — grades the candidate's spoken answer (`candidateTranscript`) against the last suggested answer (last assistant message in `conversationHistory`, "N/A" fallback) via a new `apiCall` hook (defaults to `answerCall`, so no new renderer wiring). Prompt forces a strict `{"accuracy": "X/10", "feedback": "..."}` JSON contract; markdown fences are stripped before parsing; the transcript buffer is always cleared after a grading attempt; returns `null` (with a `Grader failed` log) when there's nothing to grade or the API/parse fails.
- **`index.html`:** new `#scorecard-box` div below the answer box (slate card, blue left border) with `#score-accuracy` + `#score-feedback`; the `hotkey` listener handles `analyze-candidate` by calling `engine.analyzeCandidateResponse()` and showing the scorecard for **8 seconds** (`Score: X/10 - feedback`). Hint strip now lists `Alt+A Analyze`.
- Test Suite: **81 engine tests + 24 diagnostic tests + 9 audio-pipeline tests passing (114 total, 0 failed)** — 5 new engine tests (empty-transcript null, no-API null, grades against last assistant answer + buffer cleared, markdown-wrapped JSON, malformed output → null + buffer cleared).

## [1.13.0] - Phase 10 Part 1: Candidate Audio Capture
- **`audio-pipeline.js`:** new exported `startCandidateAudio(onCandidateTranscript, { apiKey, domain, model })` — captures the candidate's **physical microphone** via `navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true } })` (no `chromeMediaSource`), streams it to a dedicated Deepgram WebSocket (`filler_words=false` + domain keyterms), and forwards every transcript to the callback. Resolves with a `{ stop }` handle; rejects when `getUserMedia` or the API key is unavailable.
- **`engine.js`:** new `this.candidateTranscript` buffer + `handleCandidateText(text)` — a no-op unless `candidateAnalysisEnabled` is true (the Alt+V master lock), otherwise appends the candidate's spoken answer to the buffer for future Phase 10 analysis.
- **`index.html`:** `startCandidateAudio` imported; `toggle-mic` hotkey now **starts** the candidate mic on ON (guarded against double-start) routing text to `engine.handleCandidateText(text)`, and **stops** it (releasing the mic + socket) on OFF; `MIC: ERR` fallback if capture fails. Deepgram key cached for the candidate socket.
- Test Suite: **76 engine tests + 24 diagnostic tests + 9 audio-pipeline tests passing (109 total, 0 failed)** — 3 new engine tests (master lock default + gated accumulation) and 2 new audio-pipeline tests (clean rejection paths).

## [1.12.0] - Phase 10 Foundation: Candidate Mic Control
- **`Alt+V` global hotkey** (Voice) added in `main.js` (`isCandidateMicOn` state) → sends `toggle-mic` with the new ON/OFF payload; `sendHotkey` now forwards an optional payload to the renderer.
- **`index.html`:** new `MIC: OFF`/`MIC: ON` badge next to the SCRIPT/ARCHITECT badge (green `#10B981` when on, red `#EF4444` when off); hotkey hint strip now lists `Alt+V Mic`; the `hotkey` listener handles `toggle-mic` by flipping `engine.candidateAnalysisEnabled`.
- **`engine.js`:** new `this.candidateAnalysisEnabled = false` master lock in the constructor — Phase 10 (Candidate Response Analysis) logic will only execute when this is true.
- Test Suite: **73 engine tests + 24 diagnostic tests + 7 audio-pipeline tests passing (104 total, 0 failed)** — unchanged (state-only foundation, no behavior change).

## [1.11.0] - Final Core Release: Noise Gating & UI Polish
- Enabled **native WebRTC audio processing** on the captured system-audio track before it reaches the MediaRecorder/WebSocket: `echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: true` on the `getDisplayMedia` path, and (for the desktop-source `getUserMedia` fallback) the same processing requests in the `optional` constraints array — Chromium rejects these inside `mandatory` for desktop sources, so keeping them optional preserves capture while applying them where supported.
- `buildDeepgramStreamUrl` now appends **`filler_words=false`** so Deepgram drops hesitations ("um", "uh", "you know") — they never enter the transcript and never artificially extend the engine's pause-watchdog / boundary timers.
- **Phase 9 — premium teleprompter UI:** the `#answer-box` is now a distraction-free deep-slate card — `rgba(15,23,42,0.95)` background, `#F8FAFC` 18px / 1.6-line-height answer text, 20px padding, 12px radius, soft `0 4px 20px` shadow, subtle white border, `backdrop-filter: blur(10px)`, and smooth scroll pinning (`scroll-behavior: smooth` + `scrollTo({ behavior: 'smooth' })`) so the newest answer is always pinned to the bottom viewable band hands-free.
- Test Suite: **73 engine tests + 24 diagnostic tests + 7 audio-pipeline tests passing (104 total, 0 failed)**.

## [1.10.0] - Phase 7 Scenario Interceptor (Local Lightweight RAG)
- Added `knowledge/scenarios.json` as the **Master Scenario Bank** — exact-match fast-path scenarios (Atom vs Molecule, Process Property, Environment Extensions) with `id`, `keywords`, `answer`, and `type`.
- `engine.js` now loads the bank at startup via `loadScenarios()` (missing/malformed file → empty bank, engine falls back to Groq) and exposes it as `this.scenarioBank` (overridable via `opts.scenarioBank` for tests).
- Added `_searchLocalScenarios(transcript)` — an all-keywords `every()` match, case-insensitive and order-independent.
- `_runFinalAnswer` now intercepts before the Groq call: on a local hit it skips the API entirely and resolves **sub-10ms** with the stored answer (+ the type-matched opener when enabled), records the exchange into the rolling conversation memory, and reports `confidence: 'green'`.
- The speculative **draft path also intercepts** (`_runDraft`) so fast-firing drafts never waste an API call on a known scenario — the local answer is marked done and promoted instantly at the boundary.
- Test Suite: **73 engine tests + 24 diagnostic tests + 6 audio-pipeline tests passing (103 total, 0 failed)**.

## [1.9.0] - Phase 6 Conversation Memory & Confidence Scoring
- Added a rolling `conversationHistory` to `engine.js`: every completed turn pushes `{ role: 'user', content: <question> }` + `{ role: 'assistant', content: <answer> }`, capped to the **last 4 turns (8 messages)** to prevent context bloat.
- `_callAnswer` now injects the conversation history into the Groq messages array right before the current user prompt, so the model answers with full interview memory (previous Q/A are real `user`/`assistant` messages, not just a summary line).
- Both the `_runFinalAnswer` and promoted-draft (`_promoteDraftToFinal`) paths record the exchange and attach a **confidence score**.
- Added Green/Yellow/Red **boundary-confidence indicator** computed from the turn's question score: `>=60` → `green`, `35-59` → `yellow`, `<35` → `red`. Passed through every `onAnswer` payload.
- `index.html`: the `#answer-box` left border is now colored by the turn's confidence (`#10B981` green / `#F59E0B` yellow / `#EF4444` red) and cleared on reset.
- Test Suite: **66 engine tests + 24 diagnostic tests + 6 audio-pipeline tests passing (96 total, 0 failed)**.

## [1.8.0] - Phase 5 Latency Masker & Instant Opener
- Added type-matched `SAFE_OPENERS` dictionary in `engine.js` (conceptual, experience, scenario, troubleshooting, comparison, followup, best-practice, fallback) so the candidate always has something natural to say.
- `_runFinalAnswer` now picks a random opener and flashes it to the UI at **0ms** before the Groq call resolves, masking API latency behind an instant conversational opener.
- The opener is prepended to each streaming chunk AND to the final resolved answer (single, consistent opener — never duplicated).
- Added a CRITICAL RULE to `buildAnswerPrompt` forbidding the LLM from generating its own pleasantries/filler openers, preventing double-openers ("Certainly, To explain that simply, ...").
- Added an `opts.openersEnabled` hook (default on) so deterministic tests can assert exact API text.
- Test Suite: **61 engine tests + 24 diagnostic tests + 6 audio-pipeline tests passing (91 total, 0 failed)**.

## [1.7.0] - ATS Grounding & Stealth UI
- Added `knowledge/resume.md` and `knowledge/job-description.md` integration. The engine dynamically parses local Markdown profile and JD files, injecting candidate truth directly into the system prompt to guarantee contextual, first-person answers matching the candidate's real job history.
- Implemented Phase 4.6 Stealth UI ("God Mode"): Enabled native `mainWindow.setContentProtection(true)` in `main.js` to completely strip the overlay window from screen-capture software (Zoom, Teams, Google Meet, OBS).
- Added `Alt+P` Panic Mode hotkey to instantly toggle window opacity between 0% and 100% as a fail-safe.
- Added comprehensive `SHORTCUTS.md` master reference document for global OS keybindings.

## [1.6.0] - Phase 4 Grounding + Phase 4.5 Dual-Mode Output
- Added Phase 4 Flexible File-Based Resume & JD Grounding: new `knowledge/resume.md` + `knowledge/job-description.md`, loaded safely by `loadCandidateContext()` in `engine.js` and injected into every answer prompt (CANDIDATE TRUTH & TARGET JD), with a STRICT RULE enforcing first-person, no fabrication.
- Added Phase 4.5 Dual-Mode Output (Script/Architect) via `Alt+M` hotkey.

## [1.5.0] - 3-Pillar Architecture & Domain Vocabulary
- Added `domain-vocabulary.js`: single source of truth containing STT keyterms, incomplete grammar hooks, and the domain knowledge base (Boomi: Atoms, Molecules, connectors, error isolation, etc.).
- Updated `audio-pipeline.js`: `buildDeepgramStreamUrl` now accepts a `domain` config and appends each domain `stt_keyterms` entry as Nova-3 `keyterm` query parameters (not `keywords`; weights/intensifiers unsupported) to prevent mishearing jargon.
- Updated `engine.js`:
  - **Linguistic Locking** in `_boundaryDecision`: a transcript whose last word is a preposition/connector (e.g. "between", "into", "for") now unconditionally returns `wait` — the engine never finalizes a grammatically incomplete sentence, even past the 800ms pause boundary.
  - Lowered `draftDebounceMs` to 200ms and `fastDebounceMs` to 300ms for **speculative early drafting** — the background draft fires the millisecond a core keyword lands, masking Groq latency behind the interviewer's remaining speech.
  - Fixed the **draft snapshot promotion check**: `_onBoundary` now matches `draftSnapshot` against the pre-increment snapshot number, so a fast-firing draft is correctly promoted instead of triggering a duplicate final call.
  - Streamlined `buildAnswerPrompt` for concise answers: "Answer directly in 2-3 crisp, natural spoken sentences. Focus on the exact technical mechanism. Do not give generic definitions."
- Test Suite: **58 engine tests + 24 diagnostic tests + 6 audio-pipeline tests passing (88 total, 0 failed)**.

## [1.4.0] - Phase 2A Diagnostic Logger + Popup Transcript Regression Fix
- New `DiagnosticLogger` (`diagnostics.js`): JSONL session logs in `logs/`, `session_*` session IDs, monotonic `event_*` IDs, high-resolution monotonic `elapsedMs`, buffered async writes, rotation, `SESSION_SUMMARY`, per-turn performance marks + derived latency metrics, optional TXT rendering, secret redaction.
- `engine.js` instrumented via a no-op-safe `diag(eventType, data)` callback: transcript, semantic-change, state-transition, pause, boundary-candidate/decision, snapshot, turn-archival, follow-up, clear/pause/resume, timer, stale-response, and error events. `_diag`/`_emitLog` are try/catch guarded so logging can never break the pipeline.
- `main.js`: `get-env` now exposes a `diagnostics` flag (`DEBUG_DIAGNOSTICS`); `before-quit` sends `session-end` so the renderer finalizes the log.
- `index.html`: `DIAGNOSTIC SESSION` badge, logger bootstrap, Deepgram/audio events, trace events (`TRANSCRIPT_RECEIVED_FROM_DEEPGRAM` / `TRANSCRIPT_SENT_TO_UI` / `TRANSCRIPT_SENT_TO_ENGINE`, `AUDIO_CHUNK_SENT`/`AUDIO_CHUNK_SKIPPED`), and session-end handlers.
- **Popup transcript regression fix:** the Deepgram `Results` branch now updates the popup UI *before* the question/turn engine (previously `engine.processTranscript()` ran first, making `renderTranscript()` dependent on engine success). `renderTranscript()` now prefers the raw Deepgram text. Logging remains observation-only.
- `.env`: `DEBUG_DIAGNOSTICS=true`; `logs/` added to `.gitignore`.
- Test suite: new `test/diagnostics.test.js` (24 cases). Full suite: **55 engine + 24 diagnostic, 0 failed**.
- NOTE: live audio/STT validation is still pending (no Deepgram speech Results observed in the first diagnostic sessions). Phase 3 not started.

## [1.3.1] - Question / Turn Intelligence Engine (Phase 2 gaps)
- Immutable question snapshots created at a confirmed boundary (`getLatestSnapshot()` / `getTurnSnapshots()`, capped at `maxSnapshots`). Snapshot carries `turnId`, `transcript`, `timestamp`, `questionState`, `isInterim`/`isFinal`, `speechFinal`, `previousTurnId`, `decision`, `semanticClass`.
- Previous-turn archival: starting a new turn preserves the prior snapshot (`previousSnapshot`, `lastTurnId`, `TURN_ARCHIVED` log) — a new question never destroys the prior turn's state (§25).
- Explicit MINOR / MEANINGFUL / MAJOR semantic-change classification (`classifySemanticChange`, exported) used to weight state updates; domain terms (Boomi, Atom, SFTP, API…) force MAJOR.
- Short follow-up turns (`Why?`, `What about?`, `What if?`) recognized as complete follow-up turns when conversation context exists (`isShortFollowup`, exported); they no longer get dropped by the short-fragment / min-words gates.
- `clear()`/`pause()` invalidate the current-turn snapshot but keep the bounded archive; pausing produces no new snapshots; resume starts fresh.
- Test suite expanded 39 → 55 cases covering snapshots, semantic change, turn archival, short follow-ups, and bounded archive.

## [1.3.0] - Real-Time Question Intelligence Engine
- Explicit question state machine (IDLE, LISTENING, SPEECH_ACTIVE, QUESTION_BUILDING, PAUSE_DETECTED, QUESTION_CANDIDATES_READY, QUESTION_BOUNDARY_LIKELY, ANSWER_PREPARING, ANSWERING, ANSWER_READY, WAITING_FOR_MORE, FOLLOW_UP, ERROR, PAUSED) with legacy state aliases preserved for the UI.
- Silence/pause watchdog: POSSIBLE (400ms) → LIKELY (700ms) → BOUNDARY (1000ms); boundary decision finalizes only complete, high-confidence questions, otherwise waits (`WAITING_FOR_MORE`).
- Deepgram `speech_final` / `UtteranceEnd` now drive an immediate boundary decision (`handleSpeechBoundary`), in addition to the ~1s pause watchdog.
- Transcript completeness classifier tightened: missing trailers (`in`, `on`) added, over-aggressive trailer (`do`) removed so "what would you do" finalizes while "…records in" keeps waiting.
- 3-tier ranked question candidates (HIGH/MED/LOW) from the Fast Path, surfaced via `onCandidates` and the new `#question-line` UI; primary interpretation anchors the answer prompt.
- Background draft is promoted to the final answer at the speech boundary when complete (single API call, no second request).
- Authoritative final now cancels any still-pending draft timer; `_runDraft` guards against starting once a final has landed (no duplicate answer calls).
- Conversation turn IDs (`turn_001`…) emitted in state/log events.
- Buffered Groq answer streaming (clause-level chunks via SSE) instead of token-by-token.
- T0–T7 latency instrumentation reported as `[PERF]` on every final answer.
- Transcript normalization (whitespace collapse + repeated-word collapse).

## [1.0.0] - Phase 1: Floating Overlay Base
- Added frameless, transparent top-center floating window.
- Configured global hotkeys (`Alt+S`, `Alt+C`, `Alt+R`).
- Implemented visual status indicator dot and window close (`✕`) handler.

## [1.1.0] - Phase 2: Native Audio Capture & Deepgram v5.8.0
- Removed `node-record-lpcm16` dependency to avoid external SoX installation.
- Refactored `main.js` to use Deepgram SDK v5.8.0 (`DeepgramClient`).
- Implemented native browser audio stream capture via `MediaRecorder` in `index.html`.
- Connected IPC binary audio buffer stream from renderer to main process.

## [1.2.0] - Phase 3: AI Brain (Fast Path + Background Answer Path)
- Consume Deepgram interim transcript results (no longer waiting exclusively for `is_final`).
- Maintain the latest meaningful utterance and detect question confidence/incompleteness.
- Fast Path (`runFastPath`): partial transcript → Groq JSON → topic, question type, answer direction, keyword hint.
- Background Answer Path (`runDraft`): provisional natural answer drafted before the interviewer finishes, refined on new transcript words.
- Final answer (`runFinalAnswer`): generated only when the question is sufficiently complete/confident.
- Incomplete questions (`"How would you handle..."`) never finalize; the pipeline keeps listening.
- Request-ID + supersede guards reject stale API responses.
- Groq errors handled gracefully; transcript pipeline stays alive.
- Follow-up context: last 3 Q/A pairs injected into prompts (no RAG yet).
- Controlled API usage via debounce + min intervals + word-delta gating.
- Separate `#answer-box` for the natural answer; hint stays in `#fast-path`.
- Dev logging with `[P3]` tags: interim, question state, fast path, answer start/end, request ID, latency, stale, errors.
- Implemented the `Alt+R` regenerate hotkey.