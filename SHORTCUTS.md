# ⌨️ Boomi Companion - Global Shortcuts Master List

These shortcuts work globally across your entire operating system as long as the Boomi Companion application is running in the background.

## 🎙️ Audio & Transcription Controls
*   **`Alt + S`** : **Pause / Resume Listening.** Temporarily stops the engine from processing new speech (useful if you or someone else in the room is talking and you don't want the AI to process it).
*   **`Alt + C`** : **Clear Screen.** Instantly wipes the current question, transcript, and answer from the UI, giving you a clean slate for the next question.
*   **`Alt + V`** : **Toggle Candidate Microphone Analysis (ON / OFF).** Phase 10 — flips the `candidateAnalysisEnabled` master lock and the MIC badge (red `MIC: OFF` ↔ green `MIC: ON`). While ON, your spoken answer is transcribed into the engine's `candidateTranscript` buffer for grading. Default OFF.
*   **`Alt + A`** : **Analyze Candidate Spoken Answer.** Phase 10 Part 2 — grades the candidate's spoken answer against the expected (last suggested) answer via Groq and shows the scorecard (`Score: X/10` + feedback) under the teleprompter for 8 seconds.

## 🤖 AI Output Controls
*   **`Alt + M`** : **Toggle Output Mode (Script / Architect).** 
    *   *Script Mode:* Full, natural conversational sentences (first-person).
    *   *Architect Mode:* Ultra-fast, punchy bullet points and structural flows using arrows (`->`).
*   **`Alt + R`** : **Regenerate Answer.** Forces Groq to rethink and generate a new final answer based on the current question snapshot.

## 🪟 Window & Stealth Controls
*   **`Alt + Z`** : **Toggle Click-Through.** 
    *   *ON:* The window becomes a pure overlay. Mouse clicks pass directly through it into the application behind it (like your browser or IDE).
    *   *OFF:* The window can be clicked, dragged, and interacted with.
*   **`Alt + P`** : **Panic Mode (Stealth Hide).** Instantly drops the overlay's opacity to 0% making it completely invisible on your monitor, while keeping the audio and WebSocket connections running perfectly in the background. Press again to unhide.
*   **`Alt + X`** : **Toggle Window Size.** Expands or collapses the vertical height of the teleprompter window to read longer answers.

## 🎛️ Stealth Pro HUD Drawers (Update 1)
*   **`Alt + H`** : **Toggle Shortcuts Drawer.** Slides in/out the hotkey reference panel (top-right). Auto-closes after 8 seconds of mouse inactivity.
*   **`Alt + O`** : **Toggle Settings Drawer.** Slides in/out the settings panel with Window Opacity (30–100%) and Font Size (14–28px) sliders. Auto-closes after 8 seconds of mouse inactivity.
*   **Freeform Resize:** invisible drag handles on the right edge, bottom edge, and bottom-right corner let you resize the teleprompter freely (min 400×100).