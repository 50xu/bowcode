import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DesktopWindowManager } from './desktopWindow.js';
import { DesktopNotificationsController } from './desktopNotifications.js';
import { LocalServerController } from './localServer.js';
import { TabsController } from './tabs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'CloudCLI';
const APP_USER_MODEL_ID = 'ai.cloudcli.desktop';
const tabs = new TabsController();

if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

let activeTarget = { kind: 'launcher', name: APP_NAME, url: null };
let desktopWindow = null;
let localServer = null;
let desktopNotifications = null;
let isQuitting = false;

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function getLauncherPath() {
  return path.join(__dirname, 'launcher', 'index.html');
}

function getPreloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

function getWindowIconPath() {
  if (process.platform === 'darwin') return path.join(getAppRoot(), 'electron', 'assets', 'logo-macos.png');
  return path.join(getAppRoot(), 'public', 'logo-512.png');
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function getDesktopNotificationsSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-notifications-settings.json');
}

function getLocalState() {
  return {
    desktopSettings: localServer.getSettings(),
    localServerRunning: Boolean(localServer.getLocalServerUrl()),
    localWebUrl: localServer.getLocalServerUrl(),
    shareableWebUrl: localServer.getShareableWebUrl(),
  };
}

function getDesktopState() {
  return {
    activeTarget,
    ...getLocalState(),
    localStartupLogs: localServer.getStartupLogs(),
    tabs: tabs.getSerializableTabs(),
    activeTabId: tabs.activeTabId,
    desktopNotifications: desktopNotifications?.getState() || { enabled: false, supported: false, connectedCount: 0, targetCount: 0 },
  };
}

async function showError(title, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${title}: ${message}`);
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'error', title, message: title, detail: message,
  });
}

function isExpectedNavigationAbort(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error?.code === 'ERR_ABORTED' || message.includes('ERR_ABORTED') || message.includes('(-3)');
}

function syncDesktopState() {
  if (!desktopWindow) return;
  desktopWindow.buildAppMenu();
  desktopWindow.emitDesktopState();
  if (activeTarget?.kind === 'local' && !localServer?.getLocalServerUrl()) {
    void desktopWindow.showLocalStartupTarget(localServer.getPendingTarget(), localServer.getStartupLogs())
      .catch((error) => {
        if (isExpectedNavigationAbort(error)) return;
        void showError('Could not update local startup log', error);
      });
  }
}

function getDiagnosticsText() {
  const localState = getLocalState();
  return JSON.stringify({
    app: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    appPath: getAppRoot(),
    userDataPath: app.getPath('userData'),
    activeTarget,
    localServerUrl: localState.localWebUrl,
    localServerPort: localServer.localServerPort,
    localWebUrl: localState.localWebUrl,
    shareableWebUrl: localState.shareableWebUrl,
    desktopSettings: localState.desktopSettings,
  }, null, 2);
}

async function copyDiagnostics() {
  clipboard.writeText(getDiagnosticsText());
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info', title: 'Diagnostics copied', message: 'CloudCLI desktop diagnostics were copied to the clipboard.',
  });
}

async function copyLocalWebUrl() {
  await localServer.ensureLocalServer();
  const shareableUrl = localServer.getShareableWebUrl();
  const localUrl = localServer.getLocalServerUrl();
  if (!shareableUrl) throw new Error('Local CloudCLI URL is not available yet.');

  clipboard.writeText(shareableUrl);
  const isLanUrl = shareableUrl !== localUrl;
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info', title: 'Web URL copied',
    message: isLanUrl ? 'LAN web URL copied.' : 'Local web URL copied.',
    detail: isLanUrl
      ? `${shareableUrl}\n\nUse this URL from another device on the same network.`
      : `${shareableUrl}\n\nThis URL works on this computer. Enable LAN access before starting Local CloudCLI to copy a phone-accessible URL.`,
  });
  return getDesktopState();
}

async function openLocalWebUi() {
  await localServer.ensureLocalServer();
  const url = localServer.getShareableWebUrl() || localServer.getLocalServerUrl();
  if (!url) throw new Error('Local CloudCLI URL is not available yet.');
  await shell.openExternal(url);
  return getDesktopState();
}

async function updateDesktopSetting(key, value) {
  const result = await localServer.updateDesktopSetting(key, value);
  syncDesktopState();
  if (result.requiresRestartNotice) {
    await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
      type: 'info', title: 'Restart local server to apply',
      message: 'LAN access changes apply the next time the local server starts.',
      detail: 'Quit CloudCLI and stop the local server, then open Local CloudCLI again.',
    });
  }
  return getDesktopState();
}

async function openLocalInDesktop() {
  const existingTab = tabs.getTab('local');
  if (existingTab && localServer.getLocalServerUrl()) {
    await desktopWindow.showTarget(await localServer.getResolvedTarget());
    return getDesktopState();
  }
  const pendingTarget = localServer.getPendingTarget();
  tabs.upsertTarget(pendingTarget);
  activeTarget = pendingTarget;
  await desktopWindow.showLocalStartupTarget(pendingTarget, localServer.getStartupLogs());
  desktopWindow.emitDesktopState();
  await desktopWindow.showTarget(await localServer.getResolvedTarget());
  void desktopNotifications?.sync().catch((error) => console.error('[DesktopNotifications] sync failed:', error?.message || error));
  return getDesktopState();
}

async function openNotificationTarget({ sessionId = null }) {
  const window = desktopWindow?.getMainWindow();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  await openLocalInDesktop();
  if (sessionId) {
    const url = new URL(`/session/${encodeURIComponent(sessionId)}`, localServer.getLocalServerUrl()).toString();
    await desktopWindow.navigateActiveView(url);
  }
  return getDesktopState();
}

function registerIpcHandlers() {
  ipcMain.handle('cloudcli-desktop:copy-diagnostics', async () => {
    await copyDiagnostics();
    return getDesktopState();
  });
  ipcMain.handle('cloudcli-desktop:copy-local-web-url', copyLocalWebUrl);
  ipcMain.handle('cloudcli-desktop:get-state', getDesktopState);
  ipcMain.handle('cloudcli-desktop:open-local', openLocalInDesktop);
  ipcMain.handle('cloudcli-desktop:open-local-web-ui', openLocalWebUi);
  ipcMain.handle('cloudcli-desktop:reload-active-tab', () => desktopWindow.reloadActiveTab());
  ipcMain.handle('cloudcli-desktop:show-launcher', async () => {
    await desktopWindow.showLauncher();
    return getDesktopState();
  });
  ipcMain.handle('cloudcli-desktop:update-desktop-notifications', async (_event, settings) => {
    await desktopNotifications.saveSettings(settings);
    return getDesktopState();
  });
  ipcMain.handle('cloudcli-desktop:show-desktop-settings', () => desktopWindow.showDesktopSettings());
  ipcMain.handle('cloudcli-desktop:show-local-settings', () => desktopWindow.showLocalSettings());
  ipcMain.handle('cloudcli-desktop:close-settings-window', () => {
    desktopWindow.closeSettingsWindow();
    return getDesktopState();
  });
  ipcMain.handle('cloudcli-desktop:switch-tab', (_event, tabId) => desktopWindow.switchDesktopTab(tabId));
  ipcMain.handle('cloudcli-desktop:close-tab', (_event, tabId) => desktopWindow.closeDesktopTab(tabId));
  ipcMain.handle('cloudcli-desktop:update-setting', (_event, key, value) => updateDesktopSetting(key, value));
}

function registerAppEvents() {
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (desktopWindow) void desktopWindow.createWindow();
      else void createDesktopWindow();
      return;
    }
    const window = desktopWindow?.getMainWindow();
    if (window) {
      window.show();
      window.focus();
    }
  });
  app.on('before-quit', () => desktopNotifications?.stop());
  app.on('before-quit', (event) => {
    if (isQuitting || !localServer?.hasOwnedServer()) return;
    if (localServer.getSettings().keepLocalServerRunning) {
      localServer.detachOwnedServer();
      return;
    }
    event.preventDefault();
    isQuitting = true;
    void localServer.shutdownOwnedServer().finally(() => app.quit());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

async function createDesktopWindow() {
  desktopWindow = new DesktopWindowManager({
    appName: APP_NAME,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl: (url) => shell.openExternal(url),
    getDesktopState,
    getDisplayTargetName: () => activeTarget?.name || APP_NAME,
    getLocalState,
    tabs,
    actions: {
      copyDiagnostics,
      getActiveTarget: () => activeTarget,
      openLocalInDesktop,
      openLocalWebUi,
      setActiveTarget: (target) => { activeTarget = target; },
      showError,
      updateDesktopSetting,
      copyLocalWebUrl,
    },
  });
  desktopWindow.createTray();
  desktopWindow.configurePermissions();
  await desktopWindow.createWindow();
}

function registerSingleInstance() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    const window = desktopWindow?.getMainWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  return true;
}

async function bootstrap() {
  app.name = APP_NAME;
  app.setName(APP_NAME);
  process.title = APP_NAME;
  await app.whenReady();
  app.setName(APP_NAME);
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion(), copyright: 'CloudCLI' });
  localServer = new LocalServerController({
    appRoot: getAppRoot(),
    settingsPath: getSettingsPath(),
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    onChange: syncDesktopState,
  });
  desktopNotifications = new DesktopNotificationsController({
    settingsPath: getDesktopNotificationsSettingsPath(),
    appVersion: app.getVersion(),
    appName: APP_NAME,
    getRunningEnvironmentUrls: () => [localServer.getLocalServerUrl()].filter(Boolean),
    getAuthToken: (url) => desktopWindow?.readAuthTokenForTarget(url),
    getIconPath: getWindowIconPath,
    openNotificationTarget,
    onChange: syncDesktopState,
  });
  await localServer.loadDesktopSettings();
  await desktopNotifications.loadSettings();
  registerIpcHandlers();
  registerAppEvents();
  await createDesktopWindow();
  await desktopNotifications.sync();
}

if (registerSingleInstance()) {
  bootstrap().catch(async (error) => {
    await showError('CloudCLI failed to start', error);
    app.quit();
  });
}
