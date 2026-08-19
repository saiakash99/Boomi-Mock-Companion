require('dotenv').config();
const { app, BrowserWindow, globalShortcut, screen, ipcMain, desktopCapturer } = require('electron');

// Transparent + frameless windows can paint as fully invisible on Windows
// when hardware acceleration is enabled (especially combined with CSS
// backdrop-filter). Disabling it keeps the overlay reliably visible.
app.disableHardwareAcceleration();

let mainWindow;
let clickThroughEnabled = false;
let isPanicMode = false; // Alt+P — native window opacity panic toggle

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

  const sendHotkey = (action) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Restore & focus whenever a global shortcut fires: a minimized/hidden
      // window loses focus, and the hotkey must pull it back onto the screen.
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('hotkey', action);
    }
  };

  globalShortcut.register('Alt+S', () => sendHotkey('toggle-listen'));
  globalShortcut.register('Alt+C', () => sendHotkey('clear-text'));
  globalShortcut.register('Alt+R', () => sendHotkey('regenerate'));
  globalShortcut.register('Alt+X', () => sendHotkey('toggle-size'));
  globalShortcut.register('Alt+Z', () => sendHotkey('toggle-clickthrough'));
  globalShortcut.register('Alt+H', () => sendHotkey('toggle-shortcuts'));
  globalShortcut.register('Alt+M', () => sendHotkey('toggle-mode'));
  // Alt+P — Panic Mode (Stealth Hide) using native window opacity. Deliberately
  // NOT routed through sendHotkey(): while panic mode is active we do NOT want
  // to restore/focus the window (it is meant to keep the app hidden), so this
  // block handles the toggle entirely in the main process.
  globalShortcut.register('Alt+P', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    isPanicMode = !isPanicMode;

    if (isPanicMode) {
      // Make the entire OS window nearly invisible and ignore clicks.
      mainWindow.setOpacity(0.03);
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      // Restore visibility and clickability.
      mainWindow.setOpacity(1.0);
      mainWindow.setIgnoreMouseEvents(false);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Provide System Audio Source ID to Renderer
ipcMain.handle('get-desktop-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources[0]?.id;
});

// Securely provide API key to renderer. Groq/OpenRouter/Cerebras keys may be
// comma-separated pools; the router round-robins across every key per provider.
ipcMain.handle('get-env', () => ({
  deepgram: process.env.DEEPGRAM_API_KEY,
  groq: process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '',
  openrouter: process.env.OpenRouter_API_KEY || process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY || '',
  cerebras: process.env.Cerebras_API_KEY || process.env.CEREBRAS_API_KEYS || process.env.CEREBRAS_API_KEY || ''
}));

ipcMain.on('close-app', () => {
  app.quit();
});

// ---- Window controls (top-right HUD buttons) ----
ipcMain.on('window-minimize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on('window-close', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.close();
});

ipcMain.on('window-split', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { workAreaSize } = screen.getPrimaryDisplay();
  mainWindow.setSize(Math.round(workAreaSize.width / 2), Math.round(workAreaSize.height * 0.8));
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