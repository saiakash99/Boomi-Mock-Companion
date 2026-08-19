# ⌨️ Boomi Companion - Global Shortcuts Master List

These shortcuts work globally across your entire operating system as long as the Boomi Companion application is running in the background.

> **Window restore:** pressing any global shortcut while the app is minimized or
> hidden automatically restores and focuses the overlay before the action runs,
> so a hotkey always brings the teleprompter right back onto the screen.

## ✅ Registered Global Shortcuts (main.js)

| Shortcut | Action |
| --- | --- |
| `Alt + S` | **Pause / Resume Listening.** Temporarily stops the engine from processing new speech. |
| `Alt + C` | **Clear Screen.** Wipes the current question, transcript, and answer from the UI. |
| `Alt + R` | **Regenerate Answer.** Forces a new final answer based on the current question snapshot. |
| `Alt + M` | **Toggle Output Mode (Script / Architect).** Script = natural sentences; Architect = punchy bullets with `->` flow. |
| `Alt + X` | **Toggle Window Size.** Expands / collapses the teleprompter height for longer answers. |
| `Alt + Z` | **Toggle Click-Through.** ON = mouse passes through the overlay; OFF = interactive. |
| `Alt + H` | **Toggle Shortcuts Panel.** Slides the hotkey reference panel in/out (auto-closes after 8s). |
| `Alt + P` | **Toggle Panic Mode (Near 0% Opacity).** Instantly drops the overlay to ~3% opacity and ignores all clicks (Stealth Hide). Audio/WebSocket keep running. Press again to unhide. This key does NOT restore a minimized window — it is meant for hiding the app. |

## ⚠️ Not Wired to a Global Shortcut

These features exist in the UI as **buttons only** — they are NOT registered as
global shortcuts, so keyboard users must click the on-screen button instead:

*   **Candidate Mic (`toggle-mic`)** — `🎤` button in the floating pill.
*   **Analyze Candidate Answer (`analyze-candidate`)** — scorecard button.
*   **Settings Drawer (`toggle-settings`)** — gear button / "View Keyboard Shortcuts" link.

*Historical: `Alt + V` was previously documented but never registered in
`main.js`; it has been removed from this list. The actual pause/play toggle is
`Alt + S`, and Panic Hide is now the real `Alt + P` shortcut above.*