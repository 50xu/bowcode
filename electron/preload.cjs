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
  ipcRenderer.on('cloudcli-desktop:state-updated', listener);
  return () => {
    ipcRenderer.removeListener('cloudcli-desktop:state-updated', listener);
  };
}

if (isLocalAppOrigin(window.location)) {
  contextBridge.exposeInMainWorld('cloudcliDesktopNotifications', {
    getState: () => ipcRenderer.invoke('cloudcli-desktop:get-state'),
    update: (settings) => ipcRenderer.invoke('cloudcli-desktop:update-desktop-notifications', settings),
    onStateUpdated: onDesktopStateUpdated,
  });
}

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('cloudcliDesktop', {
    copyDiagnostics: () => ipcRenderer.invoke('cloudcli-desktop:copy-diagnostics'),
    copyLocalWebUrl: () => ipcRenderer.invoke('cloudcli-desktop:copy-local-web-url'),
    getState: () => ipcRenderer.invoke('cloudcli-desktop:get-state'),
    openLocal: () => ipcRenderer.invoke('cloudcli-desktop:open-local'),
    openLocalWebUi: () => ipcRenderer.invoke('cloudcli-desktop:open-local-web-ui'),
    refreshActiveTab: () => ipcRenderer.invoke('cloudcli-desktop:reload-active-tab'),
    showLauncher: () => ipcRenderer.invoke('cloudcli-desktop:show-launcher'),
    showLocalSettings: () => ipcRenderer.invoke('cloudcli-desktop:show-local-settings'),
    showDesktopSettings: () => ipcRenderer.invoke('cloudcli-desktop:show-desktop-settings'),
    closeSettingsWindow: () => ipcRenderer.invoke('cloudcli-desktop:close-settings-window'),
    switchTab: (tabId) => ipcRenderer.invoke('cloudcli-desktop:switch-tab', tabId),
    closeTab: (tabId) => ipcRenderer.invoke('cloudcli-desktop:close-tab', tabId),
    updateSetting: (key, value) => ipcRenderer.invoke('cloudcli-desktop:update-setting', key, value),
    onStateUpdated: onDesktopStateUpdated,
    onLauncherCommand: (callback) => {
      ipcRenderer.on('cloudcli-desktop:launcher-command', (_event, command) => callback(command));
    },
  });
}
