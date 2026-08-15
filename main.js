require('dotenv').config();
const { app, BrowserWindow, globalShortcut, screen, ipcMain, desktopCapturer } = require('electron');

// Transparent + frameless windows can paint as fully invisible on Windows
// when hardware acceleration is enabled (especially combined with CSS
// backdrop-filter). Disabling it keeps the overlay reliably visible.
app.disableHardwareAcceleration();

let mainWindow;
let clickThroughEnabled = false;
let isPanicMode = false;
let isCandidateMicOn = false;

app.on('web-contents-created', (event, contents) => {
  contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'display-capture' || permission === 'display-media' || permission === 'media') {
      callback(true);
      return;
    }

    callback(false);
  });
});

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: 700,
    height: 160,
    x: Math.round((width - 700) / 2),
    y: 10,
    frame: false,
    // transparent windows can fail to composite on Windows (invisible overlay);
    // use an opaque window whose bg matches the card so the overlay always shows.
    transparent: false,
    backgroundColor: '#0F172A',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minWidth: 400,
    minHeight: 100,
    show: false, // avoid focus stealing on launch
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Phase 4.6 — Stealth UI & Screen-Share Protection (God Mode):
  // natively strips the window from Zoom/Teams/OBS capture pipelines
  mainWindow.setContentProtection(true);

  // Float above all applications (including full-screen shared presentations)
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    // show without stealing focus from the interview application
    mainWindow.showInactive();
  });

  // Safety net: never leave the overlay hidden if ready-to-show is delayed/flaky
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
  }, 1500);

  // DevTools only in debug mode (opt-in via DEBUG=1) to avoid stealing focus
  if (process.env.DEBUG === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  const sendHotkey = (action, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hotkey', action, payload);
    }
  };

  globalShortcut.register('Alt+S', () => sendHotkey('toggle-listen'));
  globalShortcut.register('Alt+C', () => sendHotkey('clear-text'));
  globalShortcut.register('Alt+R', () => sendHotkey('regenerate'));
  globalShortcut.register('Alt+X', () => sendHotkey('toggle-size'));
  globalShortcut.register('Alt+Z', () => sendHotkey('toggle-clickthrough'));
  globalShortcut.register('Alt+M', () => sendHotkey('toggle-mode'));

  // Phase 10 foundation — Candidate Mic Control: Alt+V toggles whether the
  // engine listens to (and analyzes) the candidate's own microphone speech.
  // Default OFF; Phase 10 response-analysis logic will only run when ON.
  globalShortcut.register('Alt+V', () => {
    isCandidateMicOn = !isCandidateMicOn;
    sendHotkey('toggle-mic', isCandidateMicOn);
  });

  // Phase 10 Part 2 — Candidate Response Analysis: Alt+A grades the candidate's
  // spoken answer against the expected answer and shows the scorecard for 8s.
  globalShortcut.register('Alt+A', () => {
    sendHotkey('analyze-candidate');
  });

  // Phase 4.6 — Panic hotkey (Instant Vanish): Alt+P toggles stealth visibility.
  // Opacity 0 hides it visually while keeping audio/websockets running.
  globalShortcut.register('Alt+P', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    isPanicMode = !isPanicMode;
    mainWindow.setOpacity(isPanicMode ? 0 : 1);
    if (isPanicMode) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      mainWindow.setIgnoreMouseEvents(clickThroughEnabled, { forward: true });
    }
  });
}

// Prefer an app/browser window source over a full-screen capture, because
// WGC on Windows will often fail repeatedly when the capture target is the
// current Electron window or an unsuitable desktop source.
ipcMain.handle('get-desktop-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
  const preferred = (sources || []).find(source => {
    const name = String(source?.name || '').toLowerCase();
    return !name.includes('electron') && !name.includes('boomi companion') &&
      /(chrome|edge|brave|firefox|zoom|meet|youtube|browser|window|app)/i.test(name);
  }) || (sources || []).find(source => !String(source?.name || '').toLowerCase().includes('electron')) || (sources || [])[0];
  return preferred?.id || null;
});

// Securely provide API key to renderer
ipcMain.handle('get-env', () => ({ deepgram: process.env.DEEPGRAM_API_KEY, gemini: process.env.GEMINI_API_KEY, groq: process.env.GROQ_API_KEY, diagnostics: process.env.DEBUG_DIAGNOSTICS === 'true' }));

// Phase 2A: ask the renderer to finalize its diagnostic session before quitting
app.on('before-quit', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session-end');
  }
});

ipcMain.on('close-app', () => {
  app.quit();
});

ipcMain.on('resize-window', (e, isExpanded) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setSize(700, isExpanded ? 400 : 160);
});

// ---- Click-through (professional rule) ----
// Default OFF: the overlay can be configured normally.
// Toggled with Alt+Z. While ON, the window ignores mouse clicks so it never
// steals mouse input from the interview application. The renderer forwards
// hover state over the header strip, which temporarily re-enables interaction
// so the window can always be dragged / closed.
ipcMain.on('click-through-set', (e, enabled) => {
  clickThroughEnabled = !!enabled;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (clickThroughEnabled) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
});

ipcMain.on('click-through-control', (e, over) => {
  if (!clickThroughEnabled) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (over) {
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
});

app.whenReady().then(createWindow);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});