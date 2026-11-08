// Agent Office desktop app: the Electron main process. It starts (or adopts) the server, shows the office in a window or
// a small widget, keeps a tray icon that says when agents need you, and nothing else. The decisions live in ./lib and
// are unit-tested; this file wires them to Electron.
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, session, shell, Tray, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { attentionOf, newlyWaiting, notificationText, trayTooltip, type Attention } from './lib/attention';
import { CH, parseIntegration, parseIntegrationAction, parseMode, type IntegrationResult, type IntegrationsInfo, type ShellState } from './lib/ipc';
import { integrationsInfo, runInstaller } from './lib/integrations';
import { createLogger } from './lib/log';
import { DEFAULT_PORT, resolveServer, versionNote } from './lib/ports';
import { externalUrl, isAppUrl, isTrustedSender, permissionAllowed } from './lib/security';
import { startServer, type ServerHandle } from './lib/serverProcess';
import { loadSettings, saveSettings } from './lib/settings';
import { watchSnapshots } from './lib/sse';
import { nextAction } from './lib/supervisor';
import { fitBounds, MIN_SIZE, type Mode } from './lib/windowState';

const APP_ID = 'com.agentoffice.desktop';

// On a computer with no usable GPU (a virtual machine, a remote desktop) Chromium refuses WebGL unless software
// rendering is explicitly allowed. This only permits the fallback: with a GPU nothing changes.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
const HOTKEY_TOGGLE = 'CommandOrControl+Alt+O';
const HOTKEY_CLICK_THROUGH = 'CommandOrControl+Alt+C';

// ---- state -------------------------------------------------------------------------------------------------------
const userData = app.getPath('userData');
const log = createLogger(join(userData, 'logs', 'desktop.log'));
const settingsFile = join(userData, 'settings.json');
const settings = loadSettings(settingsFile);
const startHidden = process.argv.includes('--hidden');

let port = DEFAULT_PORT;
let server: ServerHandle | null = null;
let serverNote: string | null = null;
let stopWatching: (() => void) | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let clickThrough = false;
let quitting = false;
let shuttingDown = false;
let replacing = false;
let attention: Attention = { waiting: [], working: 0, total: 0 };
let seenWaiting = new Set<string>();
let firstSnapshot = true;
let serverUp = false;
const serverExits: number[] = [];
let boundsTimer: ReturnType<typeof setTimeout> | null = null;

const assetPath = (name: string) => join(__dirname, '..', 'assets', name);
const image = (name: string) => nativeImage.createFromPath(assetPath(name));

/** The release package the server runs from: bundled with the installer, or the one built next to the sources. */
function packageDir(): string {
  const fromEnv = process.env.AGENT_OFFICE_PACKAGE_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  if (app.isPackaged) return join(process.resourcesPath, 'package');
  const staged = join(__dirname, '..', '..', 'release');
  const found = existsSync(staged) ? readdirSync(staged).filter((n) => /^agent-office-\d/.test(n)).sort().pop() : undefined;
  if (!found) throw new Error('No release package found. Run: npm run desktop:dev');
  return join(staged, found);
}

function packageVersion(dir: string): string {
  try {
    return String((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version ?? app.getVersion());
  } catch {
    return app.getVersion();
  }
}

const persist = () => saveSettings(settingsFile, settings);
const baseUrl = () => `http://127.0.0.1:${port}`;

// ---- server ------------------------------------------------------------------------------------------------------
async function launchServer(entry: string): Promise<void> {
  server = await startServer({
    execPath: process.execPath,
    entry,
    port,
    onLog: (line) => log.info(`server: ${line}`),
    onUnexpectedExit: (code, signal) => void onServerExit(entry, code, signal),
  });
  serverUp = true;
  log.info(`server started on ${port} (pid ${server.pid})`);
}

async function onServerExit(entry: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
  serverUp = false;
  server = null;
  if (quitting) return;
  log.error(`server exited (code ${code}, signal ${signal})`);
  serverExits.push(Date.now());
  const next = nextAction(serverExits, Date.now());
  refreshTray();
  if (next.action === 'give-up') {
    dialog.showErrorBox('Agent Office stopped', 'The Agent Office server keeps stopping, so it was not restarted again. See the log in the app folder (logs/desktop.log), then restart the app.');
    return;
  }
  await new Promise((r) => setTimeout(r, next.delayMs));
  if (quitting) return;
  try {
    await launchServer(entry);
    refreshTray();
  } catch (err) {
    log.error(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
    void onServerExit(entry, null, null);
  }
}

// ---- window ------------------------------------------------------------------------------------------------------
function shellState(): ShellState {
  return { mode: settings.mode, pinned: settings.pinned, clickThrough, version: packageVersion(packageDir()), platform: process.platform };
}

function pushState(): void {
  if (win && !win.isDestroyed()) win.webContents.send(CH.state, shellState());
}

function currentBounds(): void {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
  settings.bounds[settings.mode] = win.getNormalBounds();
}

function scheduleSaveBounds(): void {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    currentBounds();
    persist();
  }, 500);
}

function works() {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
}

function applyWindowSettings(): void {
  if (!win || win.isDestroyed()) return;
  const widget = settings.mode === 'widget';
  win.setAlwaysOnTop(widget && settings.pinned, 'floating');
  win.setOpacity(widget ? settings.opacity : 1);
  win.setIgnoreMouseEvents(widget && clickThrough, { forward: true });
  applyOverlay();
}

function applyOverlay(): void {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  const n = attention.waiting.length;
  win.setOverlayIcon(n ? image('overlay.png') : null, n ? `${n} need${n === 1 ? 's' : ''} you` : '');
}

function loadApp(w: BrowserWindow, attempt = 0): void {
  w.loadURL(`${baseUrl()}/?shell=desktop&mode=${settings.mode}`).catch((err: unknown) => {
    if (w.isDestroyed()) return;
    log.error(`load failed (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`);
    if (attempt < 10) setTimeout(() => loadApp(w, attempt + 1), 1500);
  });
}

function createWindow(): void {
  const mode: Mode = settings.mode;
  const widget = mode === 'widget';
  const bounds = fitBounds(settings.bounds[mode], mode, works());
  const w = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE[mode].width,
    minHeight: MIN_SIZE[mode].height,
    show: false,
    frame: !widget,
    maximizable: !widget,
    fullscreenable: !widget,
    autoHideMenuBar: true,
    backgroundColor: '#14161a',
    title: 'Agent Office',
    icon: image('icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win = w;
  applyWindowSettings();
  w.once('ready-to-show', () => {
    if (!startHidden || !settings.closeToTray) w.show();
    else if (firstWindowShown) w.show();
    firstWindowShown = true;
  });
  w.webContents.on('did-finish-load', pushState);
  w.on('resize', scheduleSaveBounds);
  w.on('move', scheduleSaveBounds);
  w.on('focus', () => w.flashFrame(false));
  w.on('close', (e) => {
    if (replacing || quitting) return;
    currentBounds();
    persist();
    if (settings.closeToTray && tray) {
      e.preventDefault();
      w.hide();
    } else {
      quitting = true;
      app.quit();
    }
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });
  loadApp(w);
}
let firstWindowShown = false;

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function setMode(mode: Mode): void {
  if (mode === settings.mode && win) return;
  currentBounds();
  settings.mode = mode;
  if (mode !== 'widget') clickThrough = false;
  persist();
  // a frame can't be added or removed from a live window, so the window is replaced (the page reloads)
  const old = win;
  replacing = true;
  firstWindowShown = true;
  createWindow();
  old?.destroy();
  replacing = false;
  refreshTray();
}

function setPinned(value: boolean): void {
  settings.pinned = value;
  persist();
  applyWindowSettings();
  pushState();
  refreshTray();
}

function setClickThrough(value: boolean): void {
  clickThrough = value && settings.mode === 'widget';
  applyWindowSettings();
  pushState();
  refreshTray();
  if (clickThrough && Notification.isSupported()) new Notification({ title: 'Agent Office', body: `The widget ignores the mouse. Press ${HOTKEY_CLICK_THROUGH.replace('CommandOrControl', 'Ctrl')} or use the tray icon to turn it off.`, silent: true }).show();
}

// ---- tray --------------------------------------------------------------------------------------------------------
function buildMenu(): Menu {
  const widget = settings.mode === 'widget';
  const items: MenuItemConstructorOptions[] = [
    { label: win && win.isVisible() ? 'Hide Agent Office' : 'Show Agent Office', click: toggleWindow },
    { label: 'Open in browser', click: () => void shell.openExternal(baseUrl()) },
    { type: 'separator' },
    { label: 'Widget mode', type: 'checkbox', checked: widget, click: () => setMode(widget ? 'window' : 'widget') },
    { label: 'Keep widget on top', type: 'checkbox', checked: settings.pinned, enabled: widget, click: (i) => setPinned(i.checked) },
    { label: 'Click-through widget', type: 'checkbox', checked: clickThrough, enabled: widget, accelerator: HOTKEY_CLICK_THROUGH, click: (i) => setClickThrough(i.checked) },
    {
      label: 'Widget opacity',
      enabled: widget,
      submenu: [100, 80, 60, 40].map((pct) => ({
        label: `${pct}%`,
        type: 'radio' as const,
        checked: Math.round(settings.opacity * 100) === pct,
        click: () => {
          settings.opacity = pct / 100;
          persist();
          applyWindowSettings();
        },
      })),
    },
    { type: 'separator' },
    { label: 'Notify me when an agent needs me', type: 'checkbox', checked: settings.notifications, click: (i) => ((settings.notifications = i.checked), persist()) },
    { label: 'Close button hides to the tray', type: 'checkbox', checked: settings.closeToTray, click: (i) => ((settings.closeToTray = i.checked), persist()) },
    ...(app.isPackaged ? [{ label: 'Start with Windows', type: 'checkbox' as const, checked: settings.startAtLogin, click: (i: Electron.MenuItem) => setStartAtLogin(i.checked) }] : []),
    { label: 'Hooks and integrations…', click: () => { showWindow(); win?.webContents.send(CH.openIntegrations); } },
    { type: 'separator' },
    { label: serverUp ? `Agent Office ${packageVersion(packageDir())} · port ${port}` : 'Server not running', enabled: false },
    ...(serverNote ? [{ label: serverNote, enabled: false }] : []),
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ];
  return Menu.buildFromTemplate(items);
}

function refreshTray(): void {
  if (!tray) return;
  tray.setImage(image(attention.waiting.length ? 'tray-alert.png' : 'tray.png'));
  tray.setToolTip(serverUp ? trayTooltip(attention) : 'Agent Office: server not running');
  tray.setContextMenu(buildMenu());
  applyOverlay();
}

function setStartAtLogin(value: boolean): void {
  settings.startAtLogin = value;
  persist();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: value, args: ['--hidden'] });
}

function onSnapshot(snap: Parameters<typeof attentionOf>[0]): void {
  attention = attentionOf(snap);
  const { fresh, next } = newlyWaiting(seenWaiting, attention);
  seenWaiting = next;
  refreshTray();
  if (firstSnapshot) {
    firstSnapshot = false;
    return;
  }
  if (!fresh.length || (win && !win.isDestroyed() && win.isFocused())) return;
  if (win && !win.isDestroyed() && win.isVisible()) win.flashFrame(true);
  const text = notificationText(fresh);
  if (text && settings.notifications && Notification.isSupported()) {
    const n = new Notification({ ...text, icon: image('icon.png') });
    n.on('click', showWindow);
    n.show();
  }
}

// ---- security ----------------------------------------------------------------------------------------------------
function installSecurity(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(permissionAllowed(permission) && isTrustedSender(details.requestingUrl, port)));
  ses.setPermissionCheckHandler((_wc, permission, origin) => permissionAllowed(permission) && isAppUrl(origin, port));
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      const ext = externalUrl(url);
      if (ext) void shell.openExternal(ext);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (isAppUrl(url, port)) return;
      e.preventDefault();
      const ext = externalUrl(url);
      if (ext) void shell.openExternal(ext);
    });
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
}

function installIpc(): void {
  const ok = (e: IpcMainInvokeEvent) => isTrustedSender(e.senderFrame?.url, port);
  const options = () => ({ execPath: process.execPath, packageDir: packageDir(), port });
  ipcMain.handle(CH.getState, (e): ShellState | null => (ok(e) ? shellState() : null));
  ipcMain.handle(CH.setMode, (e, value: unknown) => {
    const mode = parseMode(value);
    if (ok(e) && mode) setMode(mode);
  });
  ipcMain.handle(CH.togglePinned, (e) => {
    if (ok(e)) setPinned(!settings.pinned);
  });
  ipcMain.handle(CH.minimize, (e) => {
    if (ok(e)) win?.minimize();
  });
  ipcMain.handle(CH.hide, (e) => {
    if (ok(e)) win?.close();
  });
  ipcMain.handle(CH.integrations, async (e): Promise<IntegrationsInfo | null> => (ok(e) ? integrationsInfo(options()) : null));
  ipcMain.handle(CH.runIntegration, async (e, id: unknown, action: unknown): Promise<IntegrationResult | null> => {
    const integration = parseIntegration(id);
    const act = parseIntegrationAction(action);
    if (!ok(e) || !integration || !act) return null;
    log.info(`integration ${act} ${integration}`);
    return runInstaller(options(), integration, act);
  });
}

// ---- lifecycle ---------------------------------------------------------------------------------------------------
async function boot(): Promise<void> {
  app.setAppUserModelId(APP_ID);
  if (app.isPackaged) Menu.setApplicationMenu(null);
  const dir = packageDir();
  const entry = join(dir, 'dist', 'server', 'index.js');
  const wanted = Number(process.env.AGENT_OFFICE_PORT) || settings.port || DEFAULT_PORT;
  const plan = await resolveServer(wanted);
  port = plan.port;
  if (plan.kind === 'adopt') {
    serverUp = true;
    serverNote = versionNote(packageVersion(dir), plan.version);
    log.info(`using the server already running on ${port} (${plan.version})`);
  } else {
    await launchServer(entry);
  }
  settings.port = port;
  persist();

  installSecurity();
  installIpc();
  tray = new Tray(image('tray.png'));
  tray.on('click', toggleWindow);
  refreshTray();
  createWindow();
  stopWatching = watchSnapshots({ base: baseUrl(), onSnapshot }).stop;
  globalShortcut.register(HOTKEY_TOGGLE, toggleWindow);
  globalShortcut.register(HOTKEY_CLICK_THROUGH, () => setClickThrough(!clickThrough));
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.startAtLogin, args: ['--hidden'] });
  log.info(`ready (${settings.mode} mode, port ${port})`);
}

async function shutdown(): Promise<void> {
  currentBounds();
  persist();
  stopWatching?.();
  globalShortcut.unregisterAll();
  await server?.stop();
  log.info('stopped');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  // the tray keeps the app alive when the window is closed
  app.on('window-all-closed', () => {});
  app.on('before-quit', (e) => {
    quitting = true;
    if (shuttingDown) return;
    shuttingDown = true;
    e.preventDefault();
    void shutdown().finally(() => app.exit(0));
  });
  void app.whenReady().then(() =>
    boot().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`could not start: ${message}`);
      dialog.showErrorBox('Agent Office could not start', message);
      app.exit(1);
    }),
  );
}
