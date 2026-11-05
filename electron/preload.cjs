const { contextBridge, ipcRenderer } = require('electron');

function isLocalAppOrigin(location) {
  if (location.protocol === 'file:') return true;

  if (location.protocol === 'http:') {
    return location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  }

  return false;
}

function onDesktopStateUpdated(callback) {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('bowcode-desktop:state-updated', listener);
  return () => {
    ipcRenderer.removeListener('bowcode-desktop:state-updated', listener);
  };
}

if (isLocalAppOrigin(window.location)) {
  const notifications = {
    getState: () => ipcRenderer.invoke('bowcode-desktop:get-state'),
    update: (settings) => ipcRenderer.invoke('bowcode-desktop:update-desktop-notifications', settings),
    onStateUpdated: onDesktopStateUpdated,
  };
  contextBridge.exposeInMainWorld('bowcodeDesktopNotifications', notifications);
}

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('bowcodeDesktop', {
    copyDiagnostics: () => ipcRenderer.invoke('bowcode-desktop:copy-diagnostics'),
    copyLocalWebUrl: () => ipcRenderer.invoke('bowcode-desktop:copy-local-web-url'),
    getState: () => ipcRenderer.invoke('bowcode-desktop:get-state'),
    openLocal: () => ipcRenderer.invoke('bowcode-desktop:open-local'),
    openLocalWebUi: () => ipcRenderer.invoke('bowcode-desktop:open-local-web-ui'),
    refreshActiveTab: () => ipcRenderer.invoke('bowcode-desktop:reload-active-tab'),
    showLauncher: () => ipcRenderer.invoke('bowcode-desktop:show-launcher'),
    showLocalSettings: () => ipcRenderer.invoke('bowcode-desktop:show-local-settings'),
    showDesktopSettings: () => ipcRenderer.invoke('bowcode-desktop:show-desktop-settings'),
    closeSettingsWindow: () => ipcRenderer.invoke('bowcode-desktop:close-settings-window'),
    switchTab: (tabId) => ipcRenderer.invoke('bowcode-desktop:switch-tab', tabId),
    closeTab: (tabId) => ipcRenderer.invoke('bowcode-desktop:close-tab', tabId),
    updateSetting: (key, value) => ipcRenderer.invoke('bowcode-desktop:update-setting', key, value),
    onStateUpdated: onDesktopStateUpdated,
    onLauncherCommand: (callback) => {
      ipcRenderer.on('bowcode-desktop:launcher-command', (_event, command) => callback(command));
    },
  });
}
