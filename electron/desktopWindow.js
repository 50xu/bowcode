import { BrowserWindow, Menu, Tray, clipboard, nativeImage, nativeTheme, session, webContents as electronWebContents } from 'electron';

import { ViewHost } from './viewHost.js';

const TITLEBAR_HEIGHT = 44;
const AUTH_TOKEN_STORAGE_KEY = 'auth-token';
function isAllowedPermissionOrigin(sourceUrl) {
  try {
    const source = new URL(sourceUrl);
    return source.protocol === 'http:' && (source.hostname === '127.0.0.1' || source.hostname === 'localhost');
  } catch {
    return false;
  }
}

function getWebContentsProcessId(contents) {
  return {
    osProcessId: typeof contents.getOSProcessId === 'function' ? contents.getOSProcessId() : null,
    processId: typeof contents.getProcessId === 'function' ? contents.getProcessId() : null,
  };
}

export class DesktopWindowManager {
  constructor({
    appName,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl,
    getDesktopState,
    getDisplayTargetName,
    getLocalState,
    actions,
    tabs,
  }) {
    this.appName = appName;
    this.getWindowIconPath = getWindowIconPath;
    this.getLauncherPath = getLauncherPath;
    this.getPreloadPath = getPreloadPath;
    this.openExternalUrl = openExternalUrl;
    this.getDesktopState = getDesktopState;
    this.getDisplayTargetName = getDisplayTargetName;
    this.getLocalState = getLocalState;
    this.actions = actions;
    this.tabs = tabs;

    this.mainWindow = null;
    this.settingsWindow = null;
    this.tray = null;
    this.launcherLoaded = false;
    this.viewHost = new ViewHost({
      appName: this.appName,
      getMainWindow: () => this.mainWindow,
      getContentViewBounds: () => this.getContentViewBounds(),
      getPreloadPath: this.getPreloadPath,
      openExternalUrl: this.openExternalUrl,
      showError: this.actions.showError,
    });
  }

  getMainWindow() {
    return this.mainWindow;
  }

  getTrayImage() {
    const image = nativeImage.createFromPath(this.getWindowIconPath());
    return image.resize({ width: 18, height: 18 });
  }

  getContentViewBounds() {
    if (!this.mainWindow) return { x: 0, y: TITLEBAR_HEIGHT, width: 0, height: 0 };
    const [width, height] = this.mainWindow.getContentSize();
    return {
      x: 0,
      y: TITLEBAR_HEIGHT,
      width,
      height: Math.max(0, height - TITLEBAR_HEIGHT),
    };
  }

  detachActiveContentView() {
    this.viewHost.detachAll();
  }

  async showTabPlaceholder(target, message) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showTabPlaceholder(tabId, target, message);
  }

  async showLocalStartupTarget(target, logs) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showLocalStartupTarget(tabId, target, logs);
  }

  async showContentTarget(target) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showContentTarget(tabId, target);
  }

  destroyTabView(tabId) {
    this.viewHost.destroyTabView(tabId);
  }

  emitDesktopState() {
    const state = this.getDesktopState();
    if (this.mainWindow && !this.mainWindow.webContents.isDestroyed()) {
      this.mainWindow.webContents.send('bowcode-desktop:state-updated', state);
    }
    if (this.settingsWindow && !this.settingsWindow.webContents.isDestroyed()) {
      this.settingsWindow.webContents.send('bowcode-desktop:state-updated', state);
    }
  }

  emitLauncherCommand(command) {
    if (!this.mainWindow || this.mainWindow.webContents.isDestroyed()) return;
    this.mainWindow.webContents.send('bowcode-desktop:launcher-command', command);
  }

  emitSettingsCommand(command) {
    if (!this.settingsWindow || this.settingsWindow.webContents.isDestroyed()) return;
    this.settingsWindow.webContents.send('bowcode-desktop:launcher-command', command);
  }

  syncSettingsWindowBounds() {
    if (!this.mainWindow || !this.settingsWindow || this.settingsWindow.isDestroyed()) return;
    this.settingsWindow.setBounds(this.mainWindow.getBounds());
  }

  async ensureSettingsWindow(sheet = 'desktop-settings') {
    if (!this.mainWindow) return null;

    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.syncSettingsWindowBounds();
      this.emitSettingsCommand({ type: 'open-sheet', sheet });
      this.settingsWindow.focus();
      return this.settingsWindow;
    }

    this.settingsWindow = new BrowserWindow({
      parent: this.mainWindow,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      movable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });
    this.syncSettingsWindowBounds();
    this.viewHost.configureChildWebContents(this.settingsWindow.webContents);
    this.settingsWindow.once('ready-to-show', () => this.settingsWindow?.show());
    this.settingsWindow.on('closed', () => {
      this.settingsWindow = null;
    });
    await this.settingsWindow.loadFile(this.getLauncherPath(), {
      query: { modal: '1', sheet },
    });
    return this.settingsWindow;
  }

  closeSettingsWindow() {
    if (!this.settingsWindow || this.settingsWindow.isDestroyed()) return;
    this.settingsWindow.close();
  }

  async showTarget(target, { trackTab = true } = {}) {
    if (!this.mainWindow) return;
    if (trackTab) {
      this.tabs.upsertTarget(target);
    }
    this.actions.setActiveTarget(target);
    this.buildAppMenu();
    this.mainWindow.setTitle(`${this.appName} - ${target.name}`);
    const finalUrl = await this.showContentTarget(target);
    this.emitDesktopState();
    return finalUrl;
  }

  async showLauncher() {
    if (!this.mainWindow) return;
    const target = { kind: 'launcher', name: this.appName, url: null };
    this.tabs.upsertTarget(target);
    this.actions.setActiveTarget(target);
    this.detachActiveContentView();
    this.buildAppMenu();
    this.mainWindow.setTitle(this.appName);
    this.mainWindow.webContents.focus();
    if (!this.launcherLoaded) {
      await this.mainWindow.loadFile(this.getLauncherPath());
      this.launcherLoaded = true;
    } else {
      this.emitDesktopState();
    }
  }

  async switchDesktopTab(tabId) {
    const tab = this.tabs.activate(tabId);
    if (!tab || !this.mainWindow) return this.getDesktopState();

    if (tab.id === 'home' || tab.kind === 'launcher') {
      await this.showLauncher();
      return this.getDesktopState();
    }

    if (!tab.target?.url) {
      throw new Error('This tab does not have a target URL.');
    }

    await this.showTarget(tab.target, { trackTab: false });
    return this.getDesktopState();
  }

  async reloadActiveTab() {
    const activeTab = this.tabs.getActiveTab();
    if (!activeTab || activeTab.id === 'home' || activeTab.kind === 'launcher') {
      this.emitDesktopState();
      return this.getDesktopState();
    }

    const reloaded = this.viewHost.reloadTab(activeTab.id);
    if (!reloaded && activeTab.target?.url) {
      await this.showTarget(activeTab.target, { trackTab: false });
    }
    this.emitDesktopState();
    return this.getDesktopState();
  }

  async navigateActiveView(url) {
    const navigated = await this.viewHost.navigateActiveView(url);
    this.emitDesktopState();
    return navigated;
  }

  async readAuthTokenForTarget(url) {
    return this.viewHost.readLocalStorageValueForOrigin(url, AUTH_TOKEN_STORAGE_KEY);
  }

  openActiveTabDevTools() {
    if (this.viewHost.openActiveViewDevTools()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before opening active tab DevTools.'));
  }

  reloadActiveBrowserViewForDiagnostics() {
    if (this.viewHost.reloadActiveView()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before reloading the active BrowserView.'));
  }

  detachActiveBrowserViewForDiagnostics() {
    if (this.viewHost.detachActiveView()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before detaching the active BrowserView.'));
  }

  copyWebContentsDiagnostics() {
    const tabViewDiagnostics = this.viewHost.getTabViewDiagnostics();
    const tabViewByContentsId = new Map(
      tabViewDiagnostics
        .filter((item) => item.webContentsId != null)
        .map((item) => [item.webContentsId, item])
    );

    const rows = electronWebContents.getAllWebContents().map((contents) => {
      const destroyed = contents.isDestroyed();
      const processIds = destroyed ? { osProcessId: null, processId: null } : getWebContentsProcessId(contents);
      const tabView = tabViewByContentsId.get(contents.id);
      let owner = 'unknown';
      if (this.mainWindow?.webContents?.id === contents.id) {
        owner = 'main-window';
      } else if (this.settingsWindow?.webContents?.id === contents.id) {
        owner = 'settings-window';
      } else if (tabView) {
        owner = `browser-view:${tabView.tabId}`;
      }

      return {
        id: contents.id,
        owner,
        osProcessId: processIds.osProcessId,
        processId: processIds.processId,
        url: destroyed ? null : contents.getURL(),
        title: destroyed ? null : contents.getTitle(),
        destroyed,
        focused: destroyed || typeof contents.isFocused !== 'function' ? false : contents.isFocused(),
        attached: tabView ? tabView.attached : null,
        active: tabView ? tabView.active : null,
      };
    });

    const activeTab = this.tabs.getActiveTab();
    const diagnostics = {
      generatedAt: new Date().toISOString(),
      activeTabId: this.tabs.activeTabId,
      activeTab: activeTab
        ? {
            id: activeTab.id,
            title: activeTab.title,
            kind: activeTab.kind,
            targetUrl: activeTab.target?.url || null,
          }
        : null,
      tabViews: tabViewDiagnostics,
      webContents: rows,
    };

    clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  }

  async closeDesktopTab(tabId) {
    const tab = this.tabs.remove(tabId);
    if (!tab) return this.getDesktopState();
    this.destroyTabView(tabId);
    if (this.tabs.activeTabId === 'home') {
      await this.showLauncher();
    } else {
      this.emitDesktopState();
    }
    return this.getDesktopState();
  }

  buildAppMenu() {
    if (!this.mainWindow) return;
    const localState = this.getLocalState();
    const template = [
      {
        label: this.appName,
        submenu: [
          { label: `About ${this.appName}`, role: 'about' },
          { type: 'separator' },
          {
            label: 'Show Launcher',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => void this.showLauncher().catch((error) => this.actions.showError('Could not show launcher', error)),
          },
          {
            label: 'Diagnostics',
            submenu: [
              {
                label: 'Copy Diagnostics',
                click: () => void this.actions.copyDiagnostics(),
              },
            ],
          },
          { type: 'separator' },
          {
            label: process.platform === 'darwin' ? `Hide ${this.appName}` : 'Hide',
            role: 'hide',
            visible: process.platform === 'darwin',
          },
          { label: 'Hide Others', role: 'hideOthers', visible: process.platform === 'darwin' },
          { label: 'Show All', role: 'unhide', visible: process.platform === 'darwin' },
          { type: 'separator', visible: process.platform === 'darwin' },
          { label: `Quit ${this.appName}`, accelerator: 'CmdOrCtrl+Q', role: 'quit' },
        ],
      },
      {
        label: 'Environment',
        submenu: [
          {
            label: 'Show Launcher',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => void this.showLauncher().catch((error) => this.actions.showError('Could not show launcher', error)),
          },
          { type: 'separator' },
          {
            label: 'Open Local Bowcode',
            accelerator: 'CmdOrCtrl+L',
            click: () => void this.actions.openLocalInDesktop().catch((error) => this.actions.showError('Could not open local Bowcode', error)),
          },
          {
            label: 'Open Local Web UI in Browser',
            accelerator: 'CmdOrCtrl+Shift+W',
            click: () => void this.actions.openLocalWebUi().catch((error) => this.actions.showError('Could not open local web UI', error)),
          },
          {
            label: 'Copy Local Web URL',
            accelerator: 'CmdOrCtrl+Shift+U',
            click: () => void this.actions.copyLocalWebUrl().catch((error) => this.actions.showError('Could not copy local web URL', error)),
          },
          { type: 'separator' },
          {
            label: 'Keep Local Server Running After Quit',
            type: 'checkbox',
            checked: localState.desktopSettings.keepLocalServerRunning,
            click: (menuItem) => void this.actions.updateDesktopSetting('keepLocalServerRunning', menuItem.checked)
              .catch((error) => this.actions.showError('Could not update desktop setting', error)),
          },
          {
            label: 'Allow LAN Access to Local Server',
            type: 'checkbox',
            checked: localState.desktopSettings.exposeLocalServerOnNetwork,
            click: (menuItem) => void this.actions.updateDesktopSetting('exposeLocalServerOnNetwork', menuItem.checked)
              .catch((error) => this.actions.showError('Could not update desktop setting', error)),
          },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          {
            label: 'Open Active Tab DevTools',
            click: () => this.openActiveTabDevTools(),
          },
          {
            label: 'Copy WebContents Diagnostics',
            click: () => this.copyWebContentsDiagnostics(),
          },
          {
            label: 'Reload Active BrowserView',
            click: () => this.reloadActiveBrowserViewForDiagnostics(),
          },
          {
            label: 'Detach Active BrowserView',
            click: () => this.detachActiveBrowserViewForDiagnostics(),
          },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : []),
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Copy Diagnostics',
            click: () => void this.actions.copyDiagnostics(),
          },
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    this.buildTrayMenu();
  }

  buildTrayMenu() {
    if (!this.tray) return;
    const localState = this.getLocalState();

    const template = [
      {
        label: 'Local',
        submenu: [
          {
            label: localState.localServerRunning ? 'Open Local in Bowcode' : 'Start Local in Bowcode',
            click: () => void this.actions.openLocalInDesktop().catch((error) => this.actions.showError('Could not open local Bowcode', error)),
          },
          {
            label: 'Open Local in Browser',
            click: () => void this.actions.openLocalWebUi().catch((error) => this.actions.showError('Could not open local web UI', error)),
          },
          {
            label: 'Copy Local URL',
            click: () => void this.actions.copyLocalWebUrl().catch((error) => this.actions.showError('Could not copy local web URL', error)),
          },
        ],
      },
      {
        label: `Quit ${this.appName}`,
        role: 'quit',
      },
    ];

    this.tray.setToolTip(`${this.appName}${this.actions.getActiveTarget()?.name ? ` - ${this.actions.getActiveTarget().name}` : ''}`);
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  async showDesktopSettings() {
    if (!this.mainWindow) return this.getDesktopState();
    await this.ensureSettingsWindow('desktop-settings');
    return this.getDesktopState();
  }

  async showLocalSettings() {
    if (!this.mainWindow) return this.getDesktopState();
    await this.ensureSettingsWindow('local-settings');
    return this.getDesktopState();
  }

  configurePermissions() {
    const isAllowedPermission = (webContents, permission) => {
      const sourceUrl = webContents.getURL();
      const allowedPermissions = new Set(['clipboard-read', 'media', 'notifications']);
      return isAllowedPermissionOrigin(sourceUrl) && allowedPermissions.has(permission);
    };

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(isAllowedPermission(webContents, permission));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      if (!webContents) return false;
      return isAllowedPermission(webContents, permission);
    });
  }

  createTray() {
    if (this.tray) return;
    this.tray = new Tray(this.getTrayImage());
    this.tray.on('click', () => {
      if (!this.mainWindow) return;
      if (this.mainWindow.isVisible()) {
        this.mainWindow.focus();
      } else {
        this.mainWindow.show();
      }
    });
    this.buildTrayMenu();
  }

  async createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1024,
      minHeight: 720,
      show: false,
      backgroundColor: '#0f172a',
      title: this.appName,
      icon: this.getWindowIconPath(),
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 18, y: 14 } }
        : {
            titleBarOverlay: {
              color: nativeTheme.shouldUseDarkColors ? '#111111' : '#f7f8fa',
              symbolColor: nativeTheme.shouldUseDarkColors ? '#a1a1a1' : '#5b6470',
              height: 44,
            },
          }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow?.show();
    });

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalUrl(url).catch((error) => this.actions.showError('Could not open external link', error));
      return { action: 'deny' };
    });

    this.mainWindow.on('resize', () => {
      this.viewHost.resizeActiveView();
      this.syncSettingsWindowBounds();
    });

    // A combined move+resize (e.g. maximize, left/top edge drags on Linux) can emit 'resize'
    // before the content area is laid out, so re-apply the view bounds once layout settles.
    this.mainWindow.contentView.on('bounds-changed', () => {
      this.viewHost.resizeActiveView();
    });

    this.mainWindow.on('move', () => {
      this.syncSettingsWindowBounds();
    });

    this.mainWindow.on('closed', () => {
      this.viewHost.clear();
      this.settingsWindow = null;
      this.mainWindow = null;
      this.launcherLoaded = false;
    });

    this.buildAppMenu();
    await this.showLauncher();
  }
}
