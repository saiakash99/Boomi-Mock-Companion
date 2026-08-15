# ðŸš€ Boomi Mock Companion - Master Project Document

## ðŸŽ¯ Project Goal
A transparent, floating desktop overlay that listens to interviewer questions via system audio, transcribes them in real-time, and uses an AI LLM to display perfect cheat-sheet answers for Boomi technical interviews.

## âŒ¨ï¸ Global Shortcut Keys
*   **`Alt + S`** : Toggle Pause/Resume Listening
*   **`Alt + C`** : Clear the current text on the screen
*   **`Alt + R`** : Regenerate the AI answer (re-runs the last answer)
*   **`Alt + X`** : Toggle overlay size (expanded / compact)
*   **`Alt + Z`** : Toggle click-through mode
*   **`Alt + P`** : Panic mode (instant vanish â€” opacity 0, keeps audio running)
*   **`Alt + M`** : Toggle Output Mode (Script/Architect)

---

## ðŸ“Š Complete Project Roadmap (Phases)

### âœ… Phase 1: Application Shell (COMPLETED)
*   **Goal:** Create the floating, transparent UI.
*   **Status:** Done. Built a borderless, always-on-top Electron `BrowserWindow` that ignores mouse clicks (click-through) but allows dragging via CSS. Integrated global hotkeys.

### âœ… Phase 2: Live Audio Transcription (COMPLETED)
*   **Goal:** Capture desktop audio and transcribe it in real-time without crashing Electron.
*   **Status:** Done. 
*   **Technical Solution:** Bypassed Electron's `Reason 263` IPC crash and Deepgram's `Error 1006` auth rejection by placing a Native Browser WebSocket directly inside `index.html`. 
*   **Flow:** `MediaRecorder` captures raw desktop audio (WebM) âž” Sent directly as Blobs to `wss://api.deepgram.com` âž” Real-time text displays on UI.

### âœ… Phase 3: AI Brain & Answer Generation (COMPLETED)
*   **Goal:** Consume live Deepgram transcripts (interim + final) and produce both an instant hint and a natural, conversational interview answer.
*   **Status:** Done. Implemented entirely inside `index.html` (renderer).
*   **Implementation:**
    1. `handleTranscript()` consumes interim + final results, maintains the current utterance, and scores question confidence/incompleteness.
    2. **Fast Path** (`runFastPath`): partial transcript â†’ Groq JSON â†’ topic, question type, answer direction, keyword hint â†’ `#fast-path`.
    3. **Background Answer Path** (`runDraft`): a provisional natural answer is generated before the interviewer finishes, then refined as new words arrive.
    4. **Final answer** (`runFinalAnswer`): generated only when the question is complete/confident â†’ `#answer-box`. Incomplete questions never finalize.
    5. Stale-response rejection via request IDs; graceful Groq error handling; follow-up Q/A context; controlled API usage (debounce + min intervals + word-delta gating).

### âœ… Phase 3.8: 3-Pillar Real-Time Interview Architecture (COMPLETED)
*   **Goal:** Make the engine hear domain jargon, recognize grammatically unfinished sentences, and draft answers speculatively early.
*   **Status:** Done. Three coordinated pillars:
    1. **Domain Vocabulary (`domain-vocabulary.js`)** â€” single source of truth per domain: `stt_keyterms` (STT vocabulary), `incomplete_hooks` (prepositions/connectors), and `knowledge_base` (Groq grounding).
    2. **Boosted STT (`audio-pipeline.js`)** â€” `buildDeepgramStreamUrl` appends every keyterm as a Nova-3 `keyterm` query parameter so Deepgram hears "Process Property", "Molecule", "SFTP" correctly.
    3. **Linguistic Locking + Speculative Drafting (`engine.js`)** â€” a trailing preposition/connector unconditionally blocks boundary finalization; `draftDebounceMs=200ms` / `fastDebounceMs=300ms` fetch the draft the moment a core keyword lands; a fixed snapshot-promotion check promotes that draft instead of double-calling the API.
*   **Tests:** 88 engine + 24 diagnostic + 9 audio-pipeline (121 total, 0 failed).

### âœ… Phase 4: ATS & Resume Grounding (COMPLETED)
*   **Goal:** Eliminate generic answers by grounding the engine in the candidate's real resume + job description.
*   **Status:** Done. File-based grounding via a `knowledge/` folder:
    1. `knowledge/resume.md` â€” candidate profile (role, experience, core skills, key projects).
    2. `knowledge/job-description.md` â€” target role + focus requirements.
    3. `loadCandidateContext()` in `engine.js` safely parses both files at construction (missing/corrupt files skipped, never throws) and builds a `[CANDIDATE TRUTH & TARGET JD]` block.
    4. The block is injected into every answer prompt as candidate truth, plus a STRICT RULE: first-person ("In my project, I implemented..."), highlight skills matching the JD, NEVER fabricate â€” topics outside the resume get "I haven't worked with that directly, but my understanding is...".
    5. `this.candidateContext` is overridable via `opts.candidateContext` for tests.

### âœ… Phase 4.5: Output Modularity (COMPLETED)
*   **Goal:** Let the candidate toggle between 'Script Mode' (full natural sentences to read aloud) and 'Architect Mode' (compact bullet points).
*   **Status:** Done. `Alt+M` global shortcut â†’ `toggle-mode` â†’ `engine.toggleOutputMode()` flips `outputMode` (`'script'` | `'architect'`). `buildAnswerPrompt` switches the FORMAT RULE accordingly (spoken 2-3 sentences vs 3-4 ultra-concise `->` bullets). A live SCRIPT/ARCHITECT badge in the status bar reflects the current mode.

### âœ… Phase 4.6: Stealth UI & Screen-Share Protection (God Mode) (COMPLETED)
*   **Goal:** Hide the overlay from Zoom/Teams/Meet/OBS screen shares with an instant panic fallback.
*   **Status:** Done.
    *   `mainWindow.setContentProtection(true)` immediately after window creation â€” natively strips the overlay from screen-capture pipelines.
    *   `mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)` + `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` â€” floats above every app, including full-screen shared presentations.
    *   `Alt+P` Panic hotkey (`isPanicMode`): `setOpacity(0)` hides visually while audio/WebSockets keep running; press again to restore opacity and the prior click-through state.

### âœ… Phase 5: Latency Masker & Instant Opener (COMPLETED)
*   **Goal:** Flash a short conversational opener to read aloud while the LLM answer streams, masking latency.
*   **Status:** Done. `SAFE_OPENERS` type-matched dictionary (conceptual / experience / scenario / troubleshooting / comparison / followup / best-practice / fallback) in `engine.js`. `_runFinalAnswer` picks a random opener, flashes it via `onAnswer` at 0ms, and prepends the SAME opener to every streaming chunk and the final answer. `buildAnswerPrompt` carries a CRITICAL RULE forbidding LLM-generated pleasantries so the opener is never duplicated. `opts.openersEnabled` (default on) hooks for deterministic tests.

### âœ… Phase 6: Extended Conversation Memory & Confidence Scoring (COMPLETED)
*   **Goal:** Let the model answer with real interview memory and show the candidate how confident the engine was in the turn's question.
*   **Status:** Done.
    *   **Rolling 4-turn context window:** every completed turn pushes `{ role: 'user', content: <question> }` + `{ role: 'assistant', content: <answer> }` into `this.conversationHistory`, capped to the **last 8 messages (4 turns)** to prevent context bloat. `_callAnswer` injects the history into the Groq messages array right before the current user prompt â€” the model sees the real prior Q/A turns, not a summary line.
    *   Both the `_runFinalAnswer` and promoted-draft (`_promoteDraftToFinal`) paths record the exchange, so a fast-firing draft that becomes the final answer is still remembered.
    *   **Green/Yellow/Red boundary-confidence indicator:** the turn's question score (0-100) maps to `confidence` â€” `>=60` â†’ `green`, `35-59` â†’ `yellow`, `<35` â†’ `red` â€” passed through every `onAnswer` payload.
    *   **Visual indicator:** in `index.html`, the `#answer-box` left border is painted with the turn's confidence (`#10B981` green / `#F59E0B` yellow / `#EF4444` red) and cleared when the box resets to "Listening for the questionâ€¦".

### âœ… Phase 7: Lightweight Scenario Interceptor (Local Fast-Path) (COMPLETED)
*   **Goal:** Answer common questions instantly from a local scenario bank instead of waiting on Groq.
*   **Status:** Done.
    *   New `knowledge/scenarios.json` â€” the **Master Scenario Bank** (`{ id, keywords, answer, type }`; ships with Atom vs Molecule, Process Property, Environment Extensions).
    *   `loadScenarios()` loads the bank at startup (missing/malformed â†’ empty bank â†’ engine falls back to Groq); exposed as `this.scenarioBank`, overridable via `opts.scenarioBank`.
    *   `_searchLocalScenarios(transcript)` â€” all-keywords `every()` match, case-insensitive and order-independent; returns the canned answer or `null`.
    *   **Sub-10ms interception:** `_runFinalAnswer` checks the bank right before the Groq call and, on a hit, skips the API entirely â€” resolves instantly with the stored answer (+ the type-matched opener when enabled), records the exchange into conversation memory, and reports `confidence: 'green'`.
    *   The speculative **draft path intercepts too** (`_runDraft`) so fast-firing drafts never spend an API call on a known scenario â€” the local answer is marked done and promoted instantly at the boundary.
*   **Tests:** 88 engine + 24 diagnostic + 9 audio-pipeline (121 total, 0 failed).

### âœ… Phase 8: Audio Noise Gating & VAD Polish (COMPLETED)
*   **Goal:** Give Deepgram the cleanest possible signal â€” native noise/echo processing on the captured track and no filler words in the transcript.
*   **Status:** Done.
    *   **Native WebRTC audio processing:** `echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: true` on the captured system-audio track before it reaches the MediaRecorder/WebSocket â€” set directly on the `getDisplayMedia` `audio` constraint (safe hints for system audio) and in the **`optional` constraints array** on the desktop-source `getUserMedia` fallback (Chromium rejects these inside `mandatory` for `chromeMediaSource: 'desktop'` with `OverconstrainedError`, so optional applies them where supported without breaking capture).
    *   **Deepgram filler-word bypass:** `buildDeepgramStreamUrl` appends **`filler_words=false`** so hesitations ("um", "uh", "you know") never enter the transcript and never artificially extend the engine's pause-watchdog / boundary timers.
    *   **Tests:** 88 engine + 24 diagnostic + 9 audio-pipeline (121 total, 0 failed) â€” 1 new test asserts `filler_words=false` is in the Deepgram URL.

### âœ… Phase 9: UI/Product Polish â€” Premium Teleprompter (COMPLETED)
*   **Goal:** Make the answer display a premium, distraction-free teleprompter the candidate reads hands-free.
*   **Status:** Done.
    *   **Teleprompter styling:** `#answer-box` is now a deep-slate `rgba(15, 23, 42, 0.95)` card â€” `#F8FAFC` 18px / 1.6 line-height answer text, 20px padding, 12px radius, `0 4px 20px` soft shadow, `1px` subtle white border, `backdrop-filter: blur(10px)`, `overflow-y: auto` + `scroll-behavior: smooth`.
    *   **Hands-free bottom-pinning:** `renderAnswer()` (invoked by `engine.onAnswer`) smooth-scrolls the newest answer to the bottom viewable band via `scrollTo({ top: scrollHeight, behavior: 'smooth' })` (with a `scrollTop` fallback) â€” the candidate never has to manually scroll while reading aloud.
    *   **Tests:** 88 engine + 24 diagnostic + 9 audio-pipeline (121 total, 0 failed). **Core MVP is 100% finished.**

### âœ… Phase 10: Candidate Response Analysis (COMPLETED)
*   **Goal:** Capture and grade the candidate's own spoken answer against the expected answer.
*   **Status:** Done.
    *   **Part 1 â€” Candidate Audio Capture:** `Alt+V` toggles the physical-mic capture (`main.js` `isCandidateMicOn` â†’ `toggle-mic` â†’ `engine.candidateAnalysisEnabled` lock). `startCandidateAudio()` in `audio-pipeline.js` streams the mic to a dedicated Deepgram WebSocket (`filler_words=false` + domain keyterms) and routes every transcript to `engine.handleCandidateText()` â†’ `engine.candidateTranscript` (gated by the lock). `MIC: ON/OFF/ERR` badge in the status bar.
    *   **Part 2 â€” Response Analysis & Scoring:** `Alt+A` (Analyze) runs `engine.analyzeCandidateResponse()` â€” a Groq grader comparing the candidate's spoken answer against the last suggested answer (last assistant message in `conversationHistory`, "N/A" fallback) via the `apiCall` hook (defaults to `answerCall`). Returns a strict `{"accuracy": "X/10", "feedback": "..."}` JSON (markdown fences stripped, transcript buffer always cleared after an attempt, `null` on no-transcript/API/parse failure). `index.html` renders the `#scorecard-box` (`Score: X/10 - feedback`) under the teleprompter for 8 seconds.
    *   **Tests:** 88 engine + 24 diagnostic + 9 audio-pipeline (121 total, 0 failed). **Phase 10 COMPLETED â€” candidate response analysis is live.**

### ✅ Phase 11: App Packaging (Electron Builder) (COMPLETED)
*   **Goal:** Package the app into a clean, installable Windows .exe - make the project ready for production.
*   **Status:** Done.
    *   **package.json:** `electron-builder` (`^26.15.3`) added as a dev dependency; new `"build": "electron-builder --win --x64"` script; root-level `"build"` config - `appId: com.boomiboss.interviewengine`, `productName: "Boomi Boss Engine"`, Windows `nsis` target (`oneClick: false`, `allowToChangeInstallationDirectory: true`), output to `dist/`.
*   `npm run build` produces the installable Windows installer via NSIS. **Project READY FOR PRODUCTION.** This completes the legacy Phase 4 #3 packaging task (legacy #1 DevTools-hide and #2 Alt+R regenerate were already delivered in earlier phases).

### ✅ Phase 12: Multi-Tier Model Split / Fuzzy RAG / Gemini Failover (COMPLETED)
*   **Goal:** Split the model tiers, make the local scenario bank fuzzy, and guarantee LLM availability via a failover router.
*   **Status:** Done.
    *   **`engine.js` — router (`routerMode`):** `DEFAULT_CFG.routerMode` (`'hybrid'` default | `'rag-only'` | `'agent-only'`) + `fastModel: 'llama-3.1-8b-instant'` (answer tier stays `llama-3.3-70b-versatile`). `_searchLocalScenarios` is disabled in `agent-only` mode and fuzzy-matches when **>= 75%** of a scenario's keywords are present. In `rag-only` mode `_runFinalAnswer`, `_runDraft`, and `_scheduleFastPath` never call an external API — a scenario miss resolves locally with the safe fallback *"I focus on Boomi integration architecture. Could you clarify your question?"*.
    *   **`index.html` — failover router:** `callWithFallback` wraps `fastPathCall`, `answerCall`, and `apiCall`. Groq is attempted first (fast tier `llama-3.1-8b-instant` / answer tier `llama-3.3-70b-versatile`) with a **500ms time-to-first-token `AbortController`** timeout (cleared on the first streamed chunk); on HTTP 429 or the TTFT abort it fails over to **Gemini 2.5 Flash** (`generateContent` for JSON, `streamGenerateContent` SSE for answers) using `process.env.GEMINI_API_KEY`. No key / non-429 error → original error rethrown.
    *   **Tests:** 88 engine + 24 diagnostic + 9 audio-pipeline (121 total, 0 failed) — 7 new engine tests for routing/fuzzy/rag-only behavior.

### ✅ Update 1: Stealth Pro UI/UX Overhaul (COMPLETED)
*   **Goal:** Upgrade the overlay into a commercial-grade teleprompter HUD without touching the audio/LLM pipeline.
*   **Status:** Done (UI-only — Deepgram WebSocket logic, Groq/Gemini routing, and `engine.js` imports untouched).
    *   **`index.html` — HUD cleanup & glassmorphism:** long shortcut string removed from the `.status-bar`; `diag-badge`/`click-badge` hidden by default; mode badge re-branded **SCRIPT → SPEAK** / **ARCHITECT → THINK** (live via `Alt+M`); `#answer-box` upgraded to `rgba(15, 23, 42, 0.85)` + `backdrop-filter: blur(12px)`.
    *   **`index.html` — floating toast scorecard:** `#scorecard-box` is now absolutely positioned (`top:15px; right:15px; z-index:1000`) with a fade in/out transition — it never shifts the answer layout. `Alt+A` floats it for 8s then fades out.
    *   **`index.html` — slide-out drawers:** `#shortcuts-drawer` (hotkey grid) + `#settings-drawer` (Window Opacity 30–100%, Font Size 14–28px sliders). `toggleDrawer(id)` slides panels via transform; auto-close after 8s of mouse inactivity. Opacity slider → `set-opacity` IPC; font-size slider live-updates `#answer-box`.
    *   **`index.html` — freeform resize handles:** invisible `e`/`s`/`se` drag zones (`e-resize`/`s-resize`/`se-resize`) that resize the window via the `resize-window-free` IPC (min 400×100).
    *   **`main.js`:** global shortcuts `Alt+H` (`toggle-shortcuts`) + `Alt+O` (`toggle-settings`); `ipcMain.on('set-opacity')` (clamped 0.1–1.0); `ipcMain.on('resize-window-free')` freeform size.
    *   **Tests:** 88 engine + 24 diagnostic + 9 audio-pipeline (121 total, 0 failed) — UI-only change, engine unaffected.

### ⚡ Phase 4 (legacy): Final Polish & Packaging (FUTURE)
*   **Goal:** Make the app ready for real-world use.
*   **Tasks:** 
    1. Hide the Developer Tools.
    2. Implement the `Alt + R` regenerate function.
    3. Package the app into a clean `.exe` Windows executable using Electron Builder.

---

## ðŸ—ï¸ Technical Architecture Rules (CRITICAL FOR AI CONTEXT)
*   **Strict Process Separation:** Do NOT send heavy audio arrays or Buffers over Electron's IPC bridge, as this causes a fatal Chromium crash (Error 263). All heavy audio processing and WebSockets MUST live inside the renderer (`index.html`).
*   **Audio Capture Constraint:** To successfully capture desktop audio in Electron without crashing, the constraints object must request BOTH `audio` and `video` (even though video is ignored). 
*   **Security:** `nodeIntegration: true` is enabled to allow local environment variables (API keys) to be passed from `main.js` to `index.html` via `ipcMain.handle`.
*   **Domain Vocabulary Is the Single Source of Truth:** all interview-domain terms (STT keyterms, incomplete grammar hooks, knowledge base) live ONLY in `domain-vocabulary.js`. `audio-pipeline.js` and `engine.js` import it via `getDomainConfig(domain)`; do not hardcode domain strings elsewhere.
*   **Linguistic Locking:** the engine MUST NEVER finalize a question whose transcript ends in a preposition/connector (between, into, from, for, about, and, or, to, of, in, onâ€¦). `_boundaryDecision` returns `wait` unconditionally for those â€” even past the 800ms pause boundary.
*   **Speculative Early Drafting:** the background draft fires as early as possible (`draftDebounceMs=200ms`, `fastDebounceMs=300ms`) so Groq latency is masked by the interviewer's remaining speech. The fast-firing draft is promoted at the boundary (never double-call the API).
*   **Nova-3 STT boosting uses `keyterm`:** Deepgram Nova-3 accepts `keyterm` query parameters (NOT `keywords`, and NO weights/intensifiers). Appended per domain vocabulary term.
*   **Candidate Truth Is the Persona Layer:** the system prompt for answers MUST include `[CANDIDATE TRUTH & TARGET JD]` from `knowledge/resume.md` + `knowledge/job-description.md` (loaded by `loadCandidateContext()`). Answers speak first-person as that candidate and never fabricate experience; topics outside the resume fall back to "I haven't worked with that directly, but my understanding is...".
*   **Stealth / God Mode is Native:** the overlay is protected from screen capture via `mainWindow.setContentProtection(true)`. `Alt+P` toggles Panic Mode (opacity 0% â†” 100%) and must never stop audio/WebSocket streams â€” only the visual layer is affected.
*   **Opener Is Local, LLM Never Opens:** `SAFE_OPENERS` (type-matched) is flashed at 0ms and prepended to the Groq stream/final by `_runFinalAnswer`. `buildAnswerPrompt` must forbid the LLM from generating its own pleasantries â€” the opener is handled LOCALLY to mask latency, and the LLM must start with the raw technical core to avoid double-openers.
*   **Conversation Memory Is a Rolling Window:** the engine keeps `this.conversationHistory` at the **last 4 turns / 8 messages** and injects it into the Groq messages array right before the current user prompt. Always cap at 8 messages to prevent context bloat; never log secrets into the history.
*   **Scenario Interceptor Is First, Groq Is Fallback:** `knowledge/scenarios.json` (Master Scenario Bank) is the first retrieval tier. `_searchLocalScenarios()` must be checked in BOTH `_runFinalAnswer` AND `_runDraft` before any `_callAnswer` â€” an all-keywords match skips the API entirely (sub-10ms, `confidence: 'green'`). Add scenarios with distinct keyword sets so they never shadow each other (e.g. `process property` vs `atom`/`molecule`); missing/empty bank must silently fall through to Groq.
*   **Native Audio Processing, Optional on Desktop Sources:** request `echoCancellation`, `noiseSuppression`, and `autoGainControl` (`true`) on the captured system-audio track. On the `getDisplayMedia` path they are plain constraint hints; on the desktop-source `getUserMedia` fallback they MUST live in the `optional` array (never `mandatory`) â€” Chromium throws `OverconstrainedError` for them inside `mandatory` with `chromeMediaSource: 'desktop'`.
*   **Filler Words Are Bypassed at the STT:** `buildDeepgramStreamUrl` MUST append `filler_words=false` so "um"/"uh"/"you know" never reach the transcript or artificially extend the engine's pause-watchdog/boundary timers.
*   **The Answer Box Is a Hands-Free Teleprompter:** `#answer-box` keeps `overflow-y: auto` + `scroll-behavior: smooth`, and every `engine.onAnswer` render smooth-pins the newest text to the bottom band (`scrollTo({ top: scrollHeight, behavior: 'smooth' })`). Never replace this with a standard scrollable chat history â€” manual scrolling breaks the hands-free reading requirement. The Green/Yellow/Red confidence indicator is painted on the left border, which must override the teleprompter's 1px border on that side only.

## ðŸ› ï¸ Software & Hardware Stack
*   **Core Framework:** Electron (Node.js backend + Chromium frontend)
*   **UI/Frontend:** Vanilla HTML, CSS, and JavaScript (No heavy frontend frameworks)
*   **Audio Capture:** Electron `desktopCapturer` combined with HTML5 `MediaRecorder` (WebM format)
*   **Speech-to-Text (STT):** Deepgram API (Nova-3 Model) connected via Native Browser WebSocket
* **Language Model (LLM):** Groq (`llama-3.3-70b-versatile`) via REST API (migrated away from Gemini)
*   **Domain Vocabulary:** `domain-vocabulary.js` â€” STT keyterms, incomplete grammar hooks, and domain knowledge base (single source of truth)
*   **Environment Management:** `dotenv` for secure API key storage

## ðŸž Known Issues & Enhancements Tracker

*Status Key: [ ] Active | [x] ~~Completed~~*

### Performance Issues
* [ ] **High STT Latency:** There is a 1-2 second delay in the audio transcription from Deepgram. Need to optimize chunk sizes (currently 250ms) or Deepgram parameters to handle fast-paced interview questions closer to real-time.
* [ ] **Question heuristic false positives:** Statements containing "can" (e.g., "you can not enableâ€¦") can trigger a background draft. Incomplete detection blocks the final answer, but tune starter matching (e.g., require "can you"/"could you") if noisy in live interviews.
* [x] ~~**Answer grounding:** Answers relied on generic Boomi domain context. Fixed by **Phase 4 â€” Resume Ingestion**: `knowledge/resume.md` + `knowledge/job-description.md` injected into every answer prompt via `loadCandidateContext()`.~~
* [x] ~~**STT mishearing of Boomi jargon** (Process Property, Molecule, SFTP). Fixed by the `keyterm` boosting in `audio-pipeline.js` from `domain-vocabulary.js`.~~
* [x] ~~**Master Scenario Bank (Phase 7):** `knowledge/scenarios.json` exact-match fast-path. `_searchLocalScenarios()` intercepts `_runFinalAnswer` AND the speculative draft â€” sub-10ms local answers with zero Groq calls (no API cost, no latency).~~
* [x] ~~**Audio Noise Gating & VAD Polish (Phase 8):** native WebRTC `echoCancellation`/`noiseSuppression`/`autoGainControl` on the captured track (optional array on desktop sources) + Deepgram `filler_words=false` so hesitations never pollute the transcript or extend pause timers.~~

### UI / UX Enhancements
* [ ] **Draggable Window:** The overlay is currently fixed at the top and blocks background browser tabs. Need to add a CSS drag region (`-webkit-app-region: drag`) so it can be moved freely around the screen.
* [ ] **Resizable Window:** Add the ability to increase the size of the overlay text box for better readability.
* [x] ~~**Dual Output Mode (Phase 4.5):** UI toggle for 'Script Mode' (full sentences) vs 'Architect Mode' (bullet points) via `Alt+M`.~~
* [x] ~~**Stealth UI & Screen-Share Protection (Phase 4.6 / God Mode):** `setContentProtection(true)` makes the overlay invisible in Zoom/Teams/Meet/OBS screen shares; `Alt+P` Panic hotkey hides instantly (opacity 0) while audio keeps running.~~
* [x] ~~**Premium Teleprompter UI (Phase 9):** `#answer-box` upgraded to a distraction-free deep-slate card (18px/1.6 text, 12px radius, blur, soft shadow) with `scroll-behavior: smooth` + `scrollTo({ behavior: 'smooth' })` bottom-pinning â€” the candidate never has to scroll manually while reading.~~
* [x] ~~**Example Fixed Issue:** Electron IPC crashing with Error 263. (Fixed by moving Deepgram WebSocket directly into index.html).~~

















ðŸŽ’ YOUR COMPLETE RESCUE BACKPACK 
       â”‚
       â”œâ”€â”€ ðŸ“„ BOOMI_MASTER_DOC.md     (The map, tracker, and rules)
       â”œâ”€â”€ ðŸ“„ new project architecture document.md  (The core architecture spec)
       â”œâ”€â”€ ðŸ“„ PROJECT_STATUS.md       (The live sync file â€” phase tracker)
       â”œâ”€â”€ ðŸ“„ CHANGELOG.md            (The version history)
       â”œâ”€â”€ ðŸ“„ SHORTCUTS.md            (The global OS keybinding master list)
       â”œâ”€â”€ ðŸ“„ domain-vocabulary.js    (STT keyterms + grammar hooks + knowledge base â€” single source of truth)
       â”œâ”€â”€ ðŸ“„ engine.js               (The question/turn engine â€” linguistic locking + speculative drafting)
       â”œâ”€â”€ ðŸ“„ audio-pipeline.js       (Deepgram keyterm URL boosting + mime picking)
       â”œâ”€â”€ ðŸ“„ diagnostics.js          (The JSONL session timeline logger)
       â”œâ”€â”€ ðŸ“‚ knowledge/              (The candidate-truth layer)
       â”‚     â”œâ”€â”€ ðŸ“„ resume.md          (candidate profile: role, skills, key projects)
       â”‚     â”œâ”€â”€ ðŸ“„ job-description.md (target role + focus requirements)
       â”‚     â””â”€â”€ ðŸ“„ scenarios.json     (Master Scenario Bank â€” sub-10ms local answers)
       â”œâ”€â”€ ðŸ“„ main.js                 (The window engine)
       â”œâ”€â”€ ðŸ“„ index.html              (The audio & UI logic)
       â”œâ”€â”€ ðŸ“„ package.json            (The installed packages list)
       â””â”€â”€ ðŸ“„ .env                    (Your secret API keys - VERY IMPORTANT!)