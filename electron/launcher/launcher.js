(function () {
  var bridge = window.cloudcliDesktop;
  var state = { desktopSettings: {}, tabs: [], localServerRunning: false };
  var app = document.getElementById('app');
  var modal = new URLSearchParams(location.search).get('modal') === '1';
  var sheet = new URLSearchParams(location.search).get('sheet') || 'desktop-settings';
  var status = '';

  function escape(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function render() {
    var settings = state.desktopSettings || {};
    var tabs = state.tabs || [];
    var active = tabs.find(function (tab) { return tab.active; });
    var url = state.shareableWebUrl || state.localWebUrl || 'Starts on demand';
    var titlebar = '<div class="titlebar"><div class="brand">CloudCLI</div><div class="tb-tabs no-drag">' + tabs.map(function (tab) {
      return '<button class="tb-tab no-drag' + (tab.active ? ' active' : '') + '" data-tab="' + escape(tab.id) + '">' + escape(tab.title) + (tab.closable ? '<span class="tb-close" data-close="' + escape(tab.id) + '">&times;</span>' : '') + '</button>';
    }).join('') + '</div><span style="flex:1"></span>' + (active && active.id !== 'home' ? '<button class="btn sm" data-action="refresh">Refresh</button>' : '') + '<button class="btn sm" data-action="settings">Settings</button></div>';
    var body = '<div class="cc-body v-sidebar"><div class="sb"><div class="sb-grp"><div class="lbl">Launcher</div><div class="sb-item active">Local servers</div></div></div><div class="sb-main"><div class="pane-h"><h2 class="pane-title">Local servers</h2></div><div class="card"><div class="card-head"><div><div class="card-t">Local server</div><div class="card-sub mono">' + escape(url) + '</div></div><button class="btn sm" data-action="local-settings">Local settings</button></div><div class="card-actions"><button class="btn pri" data-action="local">Open Local CloudCLI</button><button class="btn" data-action="web">Open in browser</button><button class="btn" data-action="copy">Copy URL</button></div></div></div></div>';
    var statusbar = '<div class="statusbar">local ' + (state.localServerRunning ? 'running' : 'idle') + '<span style="flex:1"></span>' + escape(status) + '</div>';
    app.innerHTML = modal ? '' : titlebar + body + statusbar;
    var overlay = document.getElementById('cc-overlay');
    if (!sheet) { overlay.classList.remove('open'); return; }
    var local = sheet === 'local-settings';
    overlay.classList.add('open');
    overlay.innerHTML = '<div class="cc-sheet cc-modal"><div class="cc-sheet-header"><div class="cc-sheet-copy"><div class="cc-sheet-title">' + (local ? 'Local Settings' : 'Desktop Settings') + '</div></div><button class="icon-btn cc-sheet-close" data-action="close-settings">&times;</button></div><div class="cc-sheet-body">' + (local
      ? '<section class="cc-section"><div class="cc-section-title">Local server</div><div class="cc-section-body"><div class="cc-surface"><div class="cc-meta mono">' + escape(url) + '</div><label class="cc-toggle"><input type="checkbox" data-setting="keepLocalServerRunning"' + (settings.keepLocalServerRunning ? ' checked' : '') + '>Keep server running after quit</label><label class="cc-toggle"><input type="checkbox" data-setting="exposeLocalServerOnNetwork"' + (settings.exposeLocalServerOnNetwork ? ' checked' : '') + '>Allow LAN access</label></div></div></section>'
      : '<section class="cc-section"><div class="cc-section-title">Desktop theme</div><div class="cc-section-body"><div class="cc-surface cc-choice-group">' + ['system', 'light', 'dark'].map(function (mode) { return '<label class="cc-choice"><input type="radio" name="theme" value="' + mode + '"' + ((settings.themeMode || 'system') === mode ? ' checked' : '') + '>' + mode + '</label>'; }).join('') + '</div></div></section>') + '</div></div>';
  }

  function refresh() {
    return bridge.getState().then(function (next) {
      state = next;
      var theme = (state.desktopSettings || {}).themeMode || 'system';
      document.documentElement.setAttribute('data-theme', theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme);
      render();
    });
  }

  function run(action) {
    return Promise.resolve().then(action).then(refresh).catch(function (error) { status = error.message || String(error); render(); });
  }

  document.body.classList.add(/Mac/i.test(navigator.platform) ? 'mac' : /Win/i.test(navigator.platform) ? 'win' : 'linux');
  if (modal) document.documentElement.classList.add('cc-modal-window');
  var overlay = document.createElement('div');
  overlay.id = 'cc-overlay';
  overlay.className = 'cc-overlay';
  document.body.appendChild(overlay);
  if (!modal) sheet = null;
  document.addEventListener('click', function (event) {
    var close = event.target.closest('[data-close]');
    if (close) { event.stopPropagation(); run(function () { return bridge.closeTab(close.dataset.close); }); return; }
    var tab = event.target.closest('[data-tab]');
    if (tab) { run(function () { return bridge.switchTab(tab.dataset.tab); }); return; }
    var button = event.target.closest('[data-action]');
    if (!button) return;
    var action = button.dataset.action;
    if (action === 'settings' || action === 'local-settings') { sheet = action === 'settings' ? 'desktop-settings' : 'local-settings'; render(); return; }
    if (action === 'close-settings') { sheet = null; if (modal) run(function () { return bridge.closeSettingsWindow(); }); else render(); return; }
    var methods = { local: 'openLocal', web: 'openLocalWebUi', copy: 'copyLocalWebUrl', refresh: 'refreshActiveTab' };
    if (methods[action]) run(function () { return bridge[methods[action]](); });
  });
  document.addEventListener('change', function (event) {
    var key = event.target.dataset.setting;
    if (key) run(function () { return bridge.updateSetting(key, event.target.checked); });
    if (event.target.name === 'theme') run(function () { return bridge.updateSetting('themeMode', event.target.value); });
  });
  if (bridge.onStateUpdated) bridge.onStateUpdated(function (next) { state = next; render(); });
  if (bridge.onLauncherCommand) bridge.onLauncherCommand(function (command) {
    if (command?.type === 'open-sheet') { sheet = command.sheet; render(); }
  });
  refresh();
})();
