# Boomi Mock Companion - Project Sync File

## 📊 Phase Status Tracker

| Phase | Status | Description |
| :--- | :--- | :--- |
| **1. Application Shell** | 🟢 Done | Transparent, click-through Electron overlay window with global hotkeys (Alt+S, Alt+C, Alt+R). |
| **2. Audio Engine** | 🟢 Done | Desktop audio capture using `MediaRecorder` bypassing IPC restrictions by running a Native browser WebSocket to Deepgram directly inside `index.html`. |
| **3. AI Brain** | 🟡 Pending | Capture the live transcript and send it to an LLM (OpenAI/Anthropic/Gemini) to generate interview answers on the screen. |

## 🏗️ Current Architecture (Phase 2 Completed)
To avoid Chromium `Error 263` (IPC payload crashes) and `Error 1006` (Deepgram Auth failures), the architecture is strictly divided:

*   **`main.js` (The Engine):** 
    *   Creates the transparent `BrowserWindow` with `nodeIntegration: true`.
    *   Handles global hotkeys and sends signals to the renderer.
    *   Securely passes the Deepgram API key via `ipcMain.handle('get-env')`.
*   **`index.html` (The Brain & Ears):** 
    *   Manages the UI (listening status, subtitles).
    *   Captures desktop audio (requesting both `audio` and `video` to satisfy Chromium constraints).
    *   Connects directly to Deepgram via a Native Browser WebSocket (`wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&keepalive=true`).
    *   Authenticates via subprotocol: `new WebSocket(wsUrl, ['token', apiKey])`.
    *   Sends raw audio `Blob` data directly to the WebSocket to preserve the WebM container formatting.

## 🚀 Next Steps for AI Agent
For Phase 3, we need to collect the transcribed text from Deepgram inside `index.html`, batch it into logical sentences, and send it to an LLM API to generate the cheat-sheet answers. The LLM response should then replace the Deepgram transcript on the overlay UI.
---------------------------------------
## 🏗️ Master Architecture Plan (Point 52 Deliverable)

### 1. Proposed Architecture & Tech Stack
*   **Core:** Electron (Lightweight, node integration).
*   **Audio/STT:** Desktop System Audio ➔ Deepgram Native WebSocket (`interim_results=true`).
*   **AI Engine:** Google Gemini Flash (Perfect for sub-second predictive hints and fast JSON responses).
*   **Data/Knowledge Base:** Local JSON files for the candidate's Boomi Project Profile and Resume (No cloud database needed for the MVP).

### 2. Low-Latency & Real-Time Audio Strategy
*   Streaming desktop audio chunks every 250ms directly to Deepgram.
*   Utilizing Deepgram's `interim_results` to capture partial sentences as the interviewer speaks.
*   Sending partial transcripts to Gemini Flash to generate **3-5 keywords instantly** before the question is even finished.

### 3. Two-Stage UI Architecture
The transparent floating card is split into two visual zones to prevent cognitive overload:
*   **Top Zone (Fast Path):** Large, easily scannable keywords (e.g., *Retry ➔ Log ➔ Reprocess*).
*   **Bottom Zone (Slow Path):** A short, naturally spoken 2-3 sentence conversational answer based heavily on the candidate's specific Boomi project.
/: capture mic and analyze pauses/fluency).

### 6. Major Technical Risks & Mitigations
*   **AI Hallucination:** Gemini predicting the wrong question based on the first few words. 
    *   *Mitigation:* Keep early hints broad until a clear question boundary (like a pause or question mark) is detected.
*   **API Rate Limits:** Sending partial text every 250ms-500ms could trigger rate limits. 
    *   *Mitigation:* Debounce requests. Only trigger the AI when significant semantic changes occur in the partial transcript.