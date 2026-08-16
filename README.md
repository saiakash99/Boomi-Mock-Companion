# Boomi Companion

A transparent, floating desktop overlay for **Boomi Integration Developer interview practice**. It listens to the interviewer's questions via system audio (Deepgram streaming STT), understands them in real time with a question/turn engine, and displays natural, candidate-grounded answers on a hands-free teleprompter.

> **Status:** READY FOR CONTROLLED PILOT (hardening release v2.0.0 in progress — final A–I report + build in STEP 14).

## How it works

```
System audio capture (MediaRecorder)
        |
        v
Deepgram WebSocket (Nova-3, Boomi keyterms, interim + final)
        |
        v
Question/Turn Engine (engine.js)
   - question boundary (pause ~1s / speech_final / UtteranceEnd)
   - linguistic locking (never finalize on a trailing preposition)
   - speculative early drafting (200ms debounce)
   - ranked local scenario retrieval (311-entry bank, ~4ms/hit)
   - multi-provider router: Local RAG -> Groq -> Gemini -> emergency fallback
        |
        v
Teleprompter answer (#answer-box) + live question line + hint
```

## Requirements

- Node.js (tested on v24)
- `.env` with real keys (never commit):
  - `DEEPGRAM_API_KEY`
  - `GROQ_API_KEY`
  - `GEMINI_API_KEY` (optional failover)
  - `DEBUG_DIAGNOSTICS=true`
  - `DIAGNOSTICS_PRIVACY=debug` (or `pilot` to strip candidate transcript content from logs)
- Copy `.env.example` -> `.env` if present, then fill in the keys.

## Run

```bash
npm install
npm start
```

Hotkeys (see `SHORTCUTS.md` for the full list): `Alt+S` pause, `Alt+C` clear, `Alt+R` regenerate, `Alt+M` script/architect mode, `Alt+P` panic hide, `Alt+V` candidate mic, `Alt+A` analyze the candidate's spoken answer.

## Test & build

```bash
npm test          # engine + diagnostics + audio-pipeline (+ provider-router in STEP 13)
npm run build     # electron-builder NSIS installer -> dist/  (product "Boomi Companion")
npm run generate-logo   # regenerate assets/logo.{svg,png,ico}
```

## Repo layout

- `engine.js` — question/turn intelligence engine (pure logic, no DOM).
- `provider-router.js` — multi-provider LLM router (circuit breaker + TTFT + failover).
- `diagnostics.js` — JSONL session timeline logger (pilot-privacy aware).
- `audio-pipeline.js` — Deepgram URL builder + candidate-mic capture.
- `domain-vocabulary.js` — Boomi STT keyterms + knowledge base.
- `index.html` — renderer: audio capture, UI, engine + router wiring.
- `main.js` — Electron shell, global hotkeys, secure env bridge.
- `knowledge/` — `scenarios.json` (311-entry Master Scenario Bank), `resume.md`, `job-description.md`.
- `scripts/` — `repair-scenarios.js`, `generate-logo.js`.
- `assets/` — generated logo (`logo.svg` / `logo.png` / `logo.ico`).
- `test/` — deterministic test suites.

## Documentation

- `PROJECT_STATUS.md` — live phase/status tracker.
- `BOOMI_MASTER_DOC.md` — master project document + hardening notes.
- `new project architecture document.md` — core architecture spec (Appendix H = hardening).
- `CHANGELOG.md` — version history.
- `SHORTCUTS.md` — global OS keybinding reference.

## Pilot privacy

Diagnostics default to `debug` (full transcript content logged to `logs/` for developer analysis — never shared). Set `DIAGNOSTICS_PRIVACY=pilot` in `.env` to strip candidate transcript/content from every log while preserving timing, provider, latency, and confidence metrics.