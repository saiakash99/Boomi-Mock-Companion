CURRENT PROJECT STATE
What percentage of the project is actually completed?
Approximately 85% of the core Minimum Viable Product (MVP) loop is completed. Real-time speech capture (Deepgram), the two-stage AI pipeline (Fast Path hint + Background Answer Path), and natural-answer generation (Groq) are working. Advanced configuration panels, local RAG, and non-Groq fallback integrations are still missing.

What is fully working?

Electron desktop application window wrapper setup and startup commands (npm start).

Real-time audio stream capture and transcription communication with Deepgram via WebSockets.

Automatic reconnection watchdog mechanism for the Deepgram WebSocket connection.

The "teleprompter" style UI container (#text-box) with vertical constraint (overflow-y: hidden) and auto-scrolling execution to guarantee the newest sentence stays visible without manual mouse interaction.

Integration with the Groq API (llama-3.3-70b-versatile) utilizing an authorization header via Bearer ${groqKey}.

Phase 3 AI pipeline: Deepgram interim + final transcripts → question detection → Fast Path (topic/type/direction/hint) + Background Answer Path (natural, conversational answers) with stale-response rejection, graceful error handling, follow-up context, and controlled API usage.

What is partially implemented?

Dynamic domain knowledge base toggling (currentDomain variable set to "Boomi" or "DevOps"). The structure exists, but a UI dropdown or settings panel to switch domains dynamically at runtime is not implemented.

What is only planned/scaffolded?

Advanced Retrieval-Augmented Generation (RAG) vector database or local document ingestion (only stubbed out via simple text context block prompts).

Alternative provider integration (OpenAI/OpenRouter abstractions were discussed but reverted).

What is broken?

Historical issues regarding 404 Not Found model endpoint errors (resolved by migrating to Groq) and auto-scroll blind spots have been corrected, though window resizing edge cases under extreme text sizing remain untested.

What is untested?

Long-form stress testing (running continuously for >30 minutes during a live interview simulation).

Behavior under poor network latency conditions (Groq API dropouts or rate-limiting behavior).

What is uncertain or based on assumptions?

It is assumed that the Electron main process reliably provisions process.env.GROQ_API_KEY through window.electronAPI.getEnv().

DOCUMENTATION STATUS
README: Missing — No README.md file has been generated or tracked in the project directory. Needs a quick start guide, prerequisite software instructions, and environment variable configuration steps.

Architecture Documentation: Missing — No system diagram or flow description exists outside of chat history.

Feature Documentation: Missing.

Technical Design Documents: Missing.

API Documentation: Missing — Relies on direct inline references to Deepgram WebSocket and Groq REST endpoints.

Database/Schema Documentation: N/A — No database is used.

Configuration/Environment Documentation: Missing — Environment variable rules (GROQ_API_KEY) are undocumented in files.

Setup/Run Instructions: Missing — Only referenced via conversational commands (npm start).

Testing Documentation: Missing.

Deployment Documentation: Missing.

Troubleshooting Documentation: Missing.

Known Issues: Missing.

Development Roadmap: Missing.

Changelog: Missing.

Decision Log / Architecture Decision Records (ADRs): Missing.

AI-Agent-Specific Instructions / Project Rules: Missing (contained only in user preferences context: English only, short/concise responses, scannable formatting).

DEVELOPMENT/PROJECT LOGS
TODOs / FIXMEs: None explicitly tracked via code comments in index.html.

Known Bugs / Pending Tasks: Dynamic domain switching requires manual code changes to the currentDomain variable rather than a settings interface.

Technical Debt: Minimal isolation between UI rendering logic and API network handlers inside index.html.

Temporary Workarounds: The application relies on a single monolithic index.html file housing inline styles, DOM manipulation, WebSocket state handlers, and API fetching logic instead of modular components.

Failed Approaches:

Attempting to use the non-existent gemini-3.6-flash and deprecated gemini-1.5-flash model paths (resulted in 429 and 404 errors).

Implementing a chat-style scrollable history window with visible scrollbars, which failed the core requirement of a hands-free teleprompter due to text falling into invisible "blind spots."

CODEBASE HEALTH
Important files: index.html (core frontend and controller script), Main process file (Electron backend managing environment variables).

Important folders: Standard Electron project structure.

Entry points: index.html, package entry script.

Core modules: Deepgram WebSocket client, Groq API client fetch wrapper.

Environment variables: GROQ_API_KEY (retrieved via window.electronAPI.getEnv()).

External dependencies: Deepgram SDK/WebSocket protocols, Groq chat completions REST API, Electron.

Duplicate code: Minimal, but inline styles are mixed with logic.

Temporary code: None flagged.

Hardcoded values: currentDomain = "Boomi" and static domain prompt mapping objects inside index.html.

Security concerns: API keys are passed through Electron bridge environments; care must be taken to avoid exposing keys in renderer logs.

ARCHITECTURE
What is actually implemented:

A single-window Electron application hosting a front-end interface (index.html).

Real-time audio data capture feeding a WebSocket connection to Deepgram for speech-to-text transcription.

A Phase 3 two-stage AI pipeline (all inside index.html): Fast Path (Groq JSON → topic/type/direction/hint) with a 900ms debounce + 2.5s min interval, and a Background Answer Path (provisional natural-answer drafts refined on new transcript words, finalized when the question is complete/confident). Request IDs + supersede guards reject stale responses; follow-up context carries the last 3 Q/A pairs.

A teleprompter-style display container that automatically forces vertical scrolling boundaries (overflow-y: hidden) to keep the latest transcription sentence pinned at the bottom viewable layer.

What is planned: Dynamic runtime domain-switching panels.

What was discussed but never implemented: Multi-provider failovers (OpenAI, OpenRouter) and local vector-database RAG augmentation.

REQUIREMENTS TRACEABILITY
Real-time audio transcription via Deepgram — IMPLEMENTED (Integrated in index.html via WebSockets with auto-reconnection).

Hands-free teleprompter view without blind spots — IMPLEMENTED (Configured via overflow-y: hidden and auto-scroll locking).

Groq API integration for low-latency natural language answers — IMPLEMENTED (llama-3.3-70b-versatile endpoint active).

Two-stage AI pipeline (Fast Path hint + Background natural answer) — IMPLEMENTED (Phase 3: interim results, question detection, draft-then-final, stale-response rejection).

Incomplete-question handling — IMPLEMENTED (no confident final answer until the question is complete).

Follow-up question context (last 3 Q/A) — IMPLEMENTED (no RAG).

Domain contextualization (Boomi/DevOps) — PARTIALLY IMPLEMENTED (Handled via code-level currentDomain variable rather than a user UI toggle).

Dynamic UI settings panel for switching domains or opacity — NOT STARTED.

Local vector storage / RAG document loading — NOT STARTED.

TESTING STATUS
Existing tests: None.

Missing tests: Unit tests for API error handlers, integration tests for WebSocket stability, and UI rendering tests.

Manual testing already performed: Verified local npm start execution, Deepgram speech recognition loop, Groq JSON response parsing, and teleprompter bottom-locking layout.

Phase 3 testing: 29/29 Node harness scenarios passed (incomplete question, complete question with background draft, incomplete→completed refinement, rapid successive questions + follow-up context, API failure recovery, stale draft rejected, stale final rejected, JSON parsing) plus a live `npm start` run confirming interim consumption, question detection, and Fast Path + draft calls against real Groq (~0.5s each).

Known failing tests: None (no test suite exists).

CONFIGURATION & ENVIRONMENT
Required environment variables: GROQ_API_KEY (Sensitive — DO NOT EXPOSE).

Required services: Groq Cloud API, Deepgram API.

Required software: Node.js, npm, Electron runtime environment.

Required local configuration: Local environment setup that exposes window.electronAPI.getEnv().

KNOWN PROBLEMS
Design limitations: Monolithic single-file architecture (index.html handles styling, markup, and script logic simultaneously). Scaling this file will increase technical debt.

UI/UX issues: Changing interview domains requires code modification rather than an in-app dropdown selection.

IMPORTANT DEVELOPMENT DECISIONS
Decision: Abandon Google Gemini endpoints in favor of Groq (llama-3.3-70b-versatile).

Why: Overcame persistent 429 Too Many Requests and 404 Not Found model version errors, while gaining lower inference latency.

Alternatives considered: OpenRouter, OpenAI.

Decision: Implement a rigid teleprompter container (overflow-y: hidden) instead of a traditional scrollable chat box.

Why: Eliminated user interaction requirements during live interviews so the candidate never has to touch the mouse or hunt for text in blind spots.

AI CODING CONTEXT
Coding conventions: Plain JavaScript embedded within single-file HTML or modular scripts; async/await patterns for API calls.

Files to avoid modifying unnecessarily: The core Electron main communication pipeline unless modifying environment variable bridges.

Existing patterns to follow: Keep the auto-scroll mechanism intact; maintain concise, strict system prompts for low token overhead and sub-second generation speeds.

Known AI-generated mistakes to avoid: Do not hallucinate non-existent API model tags (e.g., gemini-3.6-flash); verify active model strings against current provider documentation.

GIT / VERSION CONTROL
Current branch: Unverified / Local workspace.

Uncommitted work: Local modifications to index.html.

Files that should be committed before handover: index.html, package configurations, and Electron main files.

HANDOVER RISKS
Monolithic Code Structure: Since everything lives inside index.html, the next AI assistant might struggle with separation of concerns unless explicitly told to refactor carefully.

Implicit Environment Dependency: The app assumes window.electronAPI.getEnv() successfully injects groqKey. If run outside the Electron wrapper directly in a browser, it will fail to load configuration.

PRE-HANDOVER ACTION LIST
P1 — SHOULD COMPLETE BEFORE HANDOVER: Create a basic README.md explaining how to configure GROQ_API_KEY and run npm start.

P2 — NICE TO HAVE: Extract inline CSS and JavaScript out of index.html into separate files (styles.css, app.js) to reduce structural friction for the next AI.

P3 — CAN BE DONE AFTER HANDOVER: Implement the runtime UI dropdown selector for switching between Boomi and DevOps domains.

INFORMATION THAT MUST BE PRESERVED FOR THE NEXT AI
The Core UI Paradigm: This is a hands-free teleprompter, not a standard chat window. The window height is fixed/rigid, scrolling is disabled (overflow-y: hidden), and new transcriptions must automatically pin to the bottom viewable area without human intervention or mouse use.

API Stack: The project has officially migrated away from Google Gemini to Groq (llama-3.3-70b-versatile) using Bearer token authorization via groqKey fetched from the Electron environment (window.electronAPI.getEnv()). Do not revert to Gemini model paths.

Current Code Location: All major frontend logic, WebSocket listeners, and Groq fetch routines reside directly inside index.html. Handle script edits with caution to prevent breaking the Deepgram audio streaming loop or unbalancing closing brackets.

------------

# PROJECT TECHNICAL HANDOVER DOCUMENT

## 1. PROJECT IDENTITY
* **Project Name**: Boomi Companion (Interview Assistant)
* **Purpose**: A real-time, desktop-based AI interview assistance tool that listens to live interview audio via transcription web sockets and provides immediate, context-aware technical answers.
* **Problem Being Solved**: Eliminates the cognitive load and panic of high-stakes live technical interviews by giving candidates real-time prompts and complete, natural language answers in a distraction-free display.
* **Target Users**: Software engineers, integration developers (specifically Boomi/DevOps), and job seekers.
* **Current Development Stage**: Core MVP functional; transition phase from basic prototype to refined specialized assistant.
* **Current Completion Estimate**: ~75%
* **Technology Stack**: Electron, Node.js, JavaScript (Vanilla/ES6), HTML5/CSS3, WebSockets, REST APIs.
* **Runtime/Platform**: Desktop application (Cross-platform via Electron; tested locally via `npm start`).
* **Repository Structure**: Monolithic file structure anchored heavily around `index.html` for client rendering and an Electron main process for system bindings.

---

## 2. PROJECT VISION
* **Original Goal**: Build a quick assistant that displays keyword prompts based on live interview audio transcripts.
* **Current Implementation**: A robust desktop overlay featuring real-time Deepgram audio streaming, an auto-scrolling teleprompter view with zero blind spots, and a Groq-powered two-stage AI brain (Fast Path hint + Background natural-answer draft, finalized on complete questions) tailored by technical domains.
* **Future Vision**: Dynamic runtime domain-switching UI panels, local document RAG (Retrieval-Augmented Generation) context injection, automated screen masking ("Boss Key"), and multi-provider AI model fallback switches.

---

## 3. CURRENT STATE

| Feature | Status | Implementation Location | Remaining Work | Notes |
| :--- | :--- | :--- | :--- | :--- |
| Electron Desktop Shell | IMPLEMENTED | Main Process Entry / `index.html` | None | Stable execution via `npm start`. |
| Deepgram STT Streaming | IMPLEMENTED | `index.html` (WebSocket setup) | Add audio level indicators | Includes auto-reconnection watchdog. |
| Teleprompter Viewport | IMPLEMENTED | `index.html` (CSS `#text-box`) | None | Fixed boundaries (`overflow-y: hidden`), pins newest text automatically. |
| Groq LLM API Integration | IMPLEMENTED | `index.html` (`callGroq`, `runFastPath`, `runDraft`, `runFinalAnswer`) | None | Uses `llama-3.3-70b-versatile` via Bearer auth. |
| Phase 3 AI Brain (Fast Path + Answer) | IMPLEMENTED | `index.html` (`handleTranscript`, `analyzeQuestion`, `runFastPath`, `runDraft`, `runFinalAnswer`) | Tune confidence thresholds | Interim+final transcripts → hint + natural answer with stale guards. |
| Domain Contextualization | PARTIAL | `index.html` (`currentDomain` constant) | Build UI dropdown selector | Hardcoded to "Boomi" currently; needs dynamic toggle. |
| RAG / Local Document Ingestion | NOT IMPLEMENTED | None | Build document ingestion module | Discussed, but deferred. |

---

## 4. ARCHITECTURE
* **Components**: Electron desktop client wrapper, client-side rendering script, WebSocket manager, REST API fetch loop.
* **Modules**: Deepgram real-time audio pipeline, Groq chat completion handler.
* **Services**: Deepgram Speech-to-Text WebSocket API, Groq Cloud REST API.
* **Data Flow**: 
  1. Microphone captures audio stream ➔ 
  2. Sent via WebSocket to Deepgram (interim + final results) ➔ 
  3. `handleTranscript()` maintains the current utterance and scores question confidence/incompleteness ➔ 
  4. Fast Path (Groq JSON) returns topic/type/direction/hint → rendered in `#fast-path` ➔ 
  5. Background Answer Path drafts a natural answer early and refines it on new words ➔ 
  6. On complete/confident question, the final answer renders in `#answer-box` (stale responses dropped).
* **External Integrations**: Deepgram Cloud, Groq Cloud.
* **APIs**: Deepgram WebSocket Streaming API, Groq `/openai/v1/chat/completions` REST endpoint.
* **Database/Storage**: None (Stateless runtime session).
* **Authentication**: Environment variable API keys passed securely via Electron preload bridge (`window.electronAPI.getEnv()`).
* **Frontend**: HTML5, custom CSS styling, Vanilla JavaScript running inside an Electron renderer window.
* **Backend**: Node.js Electron main thread managing environment bridge.
* **AI Components**: Groq `llama-3.3-70b-versatile` model acting as a domain-specific interview coach.
* **Local/Desktop Architecture**: Native desktop overlay window designed to stay visible during live calls.
* **Distinction (Current vs. Planned)**: Current architecture relies on hardcoded domain constants in a single file; planned architecture requires a modular UI settings toggle and external context storage.

---

## 5. COMPLETE CODEBASE MAP
* **Path**: `index.html`
  * **Purpose**: Houses the entire frontend layout, styling, WebSocket connection logic, auto-scroll teleprompter management, and Groq API fetching.
  * **Important Functions**: `connectDeepgram()`, `handleTranscript()`, `analyzeQuestion()`, `runFastPath()`, `runDraft()`, `runFinalAnswer()`, `callGroq()`.
  * **Dependencies**: Deepgram WebSocket URL, Groq REST endpoint.
  * **Modification Rule**: Modify with extreme care; splitting logic into separate files is recommended for future maintenance.
  * **Important Warnings**: Avoid breaking closing brackets or asynchronous event handlers inside Deepgram's `onmessage` callback.

---

## 6. REQUIREMENTS TRACEABILITY
1. **Real-time audio transcription via Deepgram** — Source: User requirement; Status: IMPLEMENTED; Implementation: `index.html` WebSocket handler; Remaining Work: None; Acceptance Criteria: Live speech converts to text instantly.
2. **Hands-free teleprompter view without blind spots** — Source: User requirement; Status: IMPLEMENTED; Implementation: `index.html` CSS `#text-box` with `overflow-y: hidden`; Remaining Work: None; Acceptance Criteria: Newest text anchors at the bottom automatically without manual scrolling.
3. **Groq API integration for low-latency natural language answers** — Source: User requirement; Status: IMPLEMENTED; Implementation: `index.html` fetch request to Groq endpoint; Remaining Work: None; Acceptance Criteria: Generates natural language responses under 40 words.
4. **Domain contextualization (Boomi/DevOps)** — Source: User requirement; Status: PARTIAL; Implementation: Hardcoded `currentDomain` and `domainKnowledgeBases` objects; Remaining Work: Build runtime UI settings toggle; Acceptance Criteria: User can switch tracks seamlessly.

---

## 7. FEATURES
* **Completed**: Real-time audio ingestion, WebSocket auto-reconnection, teleprompter auto-scroll lock, Groq natural language response engine, Phase 3 Fast Path + Background Answer pipeline, incomplete-question handling, stale-response rejection, Alt+R regenerate.
* **Partial**: Domain switching (currently managed via code-level constants rather than UI controls).
* **Planned/Deferred**: Local RAG vector context, opacity hotkeys, panic-hide shortcut, multi-provider model fallbacks.

---

## 8. DATA & STATE
* **Data Models**: Stateless JSON payloads sent to Groq (`messages` array containing `system` and `user` roles).
* **Local Storage**: None used.
* **Files Generated**: None.
* **State Management**: Local JavaScript variables (`chatHistory` array, `groqKey` string, `P3` pipeline state with request IDs, timers, and Q/A context history).
* **Data Flow**: Audio chunks ➔ Deepgram transcript (interim + final) ➔ Phase 3 pipeline (question detection ➔ Fast Path hint ➔ Background draft ➔ final answer) ➔ DOM update.

---

## 9. APIS & INTEGRATIONS
* **Deepgram WebSocket API**
  * **Purpose**: Real-time speech-to-text transcription.
  * **Direction**: Inbound audio stream / Outbound WebSocket events.
  * **Authentication**: API token/Key.
  * **Current Implementation**: Active with auto-reconnect watchdog (`setTimeout` on close/error).
* **Groq Chat Completions API**
  * **Purpose**: Low-latency natural language generation.
  * **Direction**: Outbound REST POST / Inbound JSON response.
  * **Authentication**: Bearer Token (`Authorization: Bearer ${groqKey}`).
  * **Request/Response**: Standard OpenAI-compatible chat completion JSON format using model `llama-3.3-70b-versatile`.
  * **Configuration Requirements**: Valid `GROQ_API_KEY` injected via Electron environment bridge.

---

## 10. CONFIGURATION
* **Environment Variables**: `GROQ_API_KEY` (REQUIRED SECRET / NOT PROVIDED in source).
* **Required Software**: Node.js, npm, Electron.
* **Required Versions**: Node.js LTS recommended.
* **External Services**: Deepgram Cloud, Groq Cloud.

---

## 11. TESTING
* **Existing Tests**: None.
* **Missing Tests**: Automated unit and integration test suites.
* **Manual Tests Performed**: Verified `npm start` execution, speech recognition loop, Groq text parsing, and teleprompter bottom-locking layout.
* **Untested Areas**: Extended network drops, high-latency throttling, extreme text wrapping on varied monitor resolutions.

---

## 12. KNOWN BUGS & TECHNICAL DEBT
* **Monolithic File Structure**: All HTML, CSS, and JS reside within `index.html`, creating high coupling and technical debt.
* **Static Domain Switching**: Changing domains (e.g., Boomi to DevOps) requires modifying code variables rather than interacting with a UI element.

---

## 13. IMPORTANT DEVELOPMENT HISTORY
* **Migrated from Gemini to Groq**: Abandoned Google Gemini models due to persistent `429 Too Many Requests` rate limits and `404 Not Found` endpoint shifts. Groq (`llama-3.3-70b-versatile`) was adopted for superior speed and stability.
* **Teleprompter UI Paradigm**: Abandoned standard scrollable chat interfaces with visible scrollbars because they introduced "blind spots" that forced manual mouse interaction during live interviews. Implemented rigid height constraints (`overflow-y: hidden`) with automatic bottom-pinning.

---

## 14. AI CODING RULES
* **DO**:
  * Preserve the hands-free teleprompter auto-scroll behavior.
  * Reuse existing asynchronous fetch patterns and error-handling blocks.
  * Keep system prompts concise to preserve low token overhead and sub-second generation speeds.
  * Verify model strings against current provider documentation before implementation.
* **DO NOT**:
  * Introduce unverified or deprecated model endpoints.
  * Rewrite working WebSocket structures without justification.
  * Expose API secrets in client-side logs or repository files.
  * Assume planned features (like dynamic UI toggles or RAG) are already built.

---

## 15. CURRENT TODO / ROADMAP
* **P0 — Critical**:
  * Ensure environment variable bridging for `GROQ_API_KEY` remains intact across reloads.
* **P1 — High**:
  * Create a baseline `README.md` file documenting setup and execution instructions.
* **P2 — Medium**:
  * Refactor monolithic `index.html` script blocks into modular files (`styles.css`, `app.js`) to ease future development.
* **P3 — Future**:
  * Build an in-app UI settings panel to toggle interview domains dynamically.

---

## 16. IMMEDIATE NEXT STEPS
1. Verify local environment setup and run `npm start` to confirm clean boot.
2. Draft and commit a clear `README.md` for project onboarding documentation.
3. Begin modularizing `index.html` if expanding feature sets beyond the core MVP.

---

## 17. HANDOVER CHECKLIST
* [x] Core STT transcription loop verified.
* [x] Teleprompter layout stability confirmed.
* [x] Groq API integration finalized.
* [x] Phase 3 Fast Path + Background Answer pipeline verified.
* [ ] Modular code extraction completed.
* [ ] README documentation generated.

---

## 18. PROJECT RISKS
* **Architectural Scalability**: Continued development inside a single monolithic HTML file increases the risk of regressions.
* **API Dependency**: Heavy reliance on third-party uptime (Deepgram and Groq cloud services).

---

## 19. UNKNOWN / NEEDS VERIFICATION
* Exact behavior under prolonged multi-hour live session use without application restarts.

---

## 20. NEXT AI QUICK CONTEXT
* **What the application is**: A real-time desktop interview assistance tool driven by live audio transcription and ultra-fast LLM responses.
* **Current completion**: ~75% (Core pipeline complete; UI modularization and dynamic settings pending).
* **Current architecture**: Single-window Electron client running speech pipelines via Deepgram WebSockets and answering via Groq REST endpoints.
* **Main technologies**: Electron, Node.js, JavaScript, WebSockets, Groq API, Deepgram API.
* **What is already working**: Audio capture, transcription, WebSocket auto-reconnection, teleprompter auto-scroll pinning, and Groq natural language answers.
* **What is currently being built**: Handover state documentation and cleanup preparation.
* **Biggest known problems**: Monolithic code arrangement inside `index.html`; lack of dynamic UI settings panels.
* **Immediate next task**: Create project documentation (`README.md`) and evaluate file modularization.
* **Important rules**: Maintain the rigid teleprompter design; never reintroduce unstable Google model endpoints; keep system prompts optimized for speed.
* **Critical files**: `index.html`.
* **Important decisions**: Migrated to Groq for speed/stability; enforced strict teleprompter framing to eliminate manual mouse scrolling.
* **Things not to break**: The WebSocket auto-reconnect watchdog and the bottom-pinned teleprompter display behavior.