// Quire desktop shell. A thin native wrapper: the main window loads the Pi-hosted Quire over the
// default (persistent) session, so the GitHub/NextAuth sign-in is done once in-window and survives
// relaunches. Workstream C will add the Lemida engine (embedded sign-in + headless sync) in src/engine
// and wire it to `signInToLemida()` below.
import path from 'node:path';
import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from 'electron';
import { loadConfig } from './config';
import { fillStep } from './engine/credential-bar';
import * as creds from './engine/credentials';
import { LemidaEngine } from './engine/engine';

let mainWindow: BrowserWindow | null = null;
let credentialsWindow: BrowserWindow | null = null;
let engine: LemidaEngine | null = null;

/**
 * The main window, exposed for the Lemida engine (Workstream C) to push `lemida:status` updates to the
 * renderer via `getMainWindow()?.webContents.send('lemida:status', …)`.
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

// --- Lemida sign-in ---------------------------------------------------------------------------------
// Opens the embedded sign-in window (a visible BrowserWindow on the `persist:lemida` partition), lets
// you sign in by hand, captures the session, and reports status. Backed by the engine in src/engine.
async function signInToLemida(): Promise<{ ok: boolean; reason?: string }> {
  if (!engine) return { ok: false, reason: 'engine-not-ready' };
  return engine.signIn();
}

// --- Lemida credentials -----------------------------------------------------------------------------
// A small dialog to store the BIU username / password / TOTP setup key (encrypted in the Keychain via the
// `credentials` module). Opened from the Lemida menu and from the sign-in helper's "Edit credentials…" link.
function openCredentialsWindow(): void {
  if (credentialsWindow && !credentialsWindow.isDestroyed()) {
    credentialsWindow.focus();
    return;
  }
  credentialsWindow = new BrowserWindow({
    width: 460,
    height: 600,
    title: 'Lemida credentials',
    resizable: false,
    minimizable: false,
    parent: mainWindow ?? undefined,
    backgroundColor: '#1C1915',
    webPreferences: {
      preload: path.join(__dirname, 'ui/credentials-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void credentialsWindow.loadFile(path.join(__dirname, 'ui/credentials.html'));
  credentialsWindow.on('closed', () => {
    credentialsWindow = null;
  });
}

function createWindow(quireUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Quire',
    backgroundColor: '#1C1915',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // No `partition` here on purpose: the main window uses the default persistent session so the
      // NextAuth cookie is stored under userData and reused across launches.
    },
  });

  const quireOrigin = safeOrigin(quireUrl);

  // Popups / target=_blank / window.open: these are "open this elsewhere" links (a Lemida course page,
  // an external resource). Send them to the system browser. We deliberately do NOT intercept in-window
  // (will-navigate) cross-origin navigations, because the GitHub OAuth sign-in is a sequence of
  // top-level redirects (quire → github.com → callback) that MUST complete in this window to land the
  // session cookie in our session. Letting them run in-window is what makes the session-cookie auth work.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void win.loadURL(quireUrl);
  // Keep the origin check available to future code (engine link handling) without re-parsing.
  void quireOrigin;
  return win;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Lemida',
      submenu: [
        {
          label: 'Sign in to Lemida…',
          click: () => {
            void signInToLemida();
          },
        },
        {
          label: 'Credentials…',
          click: () => openCredentialsWindow(),
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  const config = loadConfig();

  ipcMain.handle('lemida:sign-in', (_event: IpcMainInvokeEvent) => signInToLemida());

  // Credential vault + autofill. These channels are only reachable from our own trusted preloads (the sign-in
  // helper and the credentials dialog); the Pi-served main window's preload does not expose them.
  ipcMain.handle('lemida-creds:status', () => creds.status());
  ipcMain.handle('lemida-creds:save', (_e: IpcMainInvokeEvent, data: creds.CredInput) => creds.save(data));
  ipcMain.handle('lemida-creds:preview-totp', (_e: IpcMainInvokeEvent, secret: string) =>
    creds.previewCode(secret),
  );
  ipcMain.handle('lemida-creds:current-totp', () => creds.currentCode());
  ipcMain.handle('lemida-creds:open-settings', () => openCredentialsWindow());
  ipcMain.handle(
    'lemida-fill',
    (_e: IpcMainInvokeEvent, { field }: { field: Parameters<typeof fillStep>[0] }) => fillStep(field),
  );

  buildMenu();
  mainWindow = createWindow(config.quireUrl);

  // The Lemida engine: polls the Pi for panel-queued commands and runs the embedded sign-in / sync.
  // It pushes status to the renderer via `lemida:status` (the preload exposes onLemidaStatus()).
  engine = new LemidaEngine({
    quireUrl: config.quireUrl,
    emit: (status) => getMainWindow()?.webContents.send('lemida:status', status),
  });
  void engine.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(config.quireUrl);
    }
  });
});

app.on('before-quit', () => {
  engine?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
