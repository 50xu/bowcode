import path from 'node:path';

type ServiceDependencies = {
  platform: string;
  home: string;
  uid: number;
  nodePath: string;
  cliPath: string;
  pathEnv: string;
  exists(filePath: string): boolean;
  read(filePath: string): string;
  write(filePath: string, content: string): void;
  mkdir(directory: string): void;
  remove(filePath: string): void;
  exec(command: string, args: string[]): Promise<boolean>;
  log(message: string): void;
  error(message: string): void;
};

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** CLI dispatcher uses this command to manage only Bowcode-owned user services. */
export function createServiceCommand(deps: ServiceDependencies) {
  return async (args: string[]): Promise<number> => {
    const [action] = args;
    if (!['install', 'uninstall', 'status'].includes(action)) {
      deps.error('Usage: bowcode service install|uninstall|status [--port N] [--host HOST] [--force]');
      return 1;
    }
    if (deps.platform !== 'linux' && deps.platform !== 'darwin') {
      deps.error('Service management is supported only on Linux and macOS');
      return 1;
    }
    const linux = deps.platform === 'linux';
    const unit = linux ? path.join(deps.home, '.config/systemd/user/bowcode.service') : path.join(deps.home, 'Library/LaunchAgents/dev.bowcode.plist');
    const installed = deps.exists(unit);
    const managed = installed && deps.read(unit).includes('managed-by: bowcode');
    if (action === 'status') {
      deps.log(installed ? managed ? 'Bowcode service installed' : 'Unmanaged service exists' : 'Bowcode service not installed');
      return 0;
    }
    if (installed && !managed && !args.includes('--force')) {
      deps.error('Existing unmanaged service; pass --force to replace it');
      return 1;
    }
    const domain = `gui/${deps.uid}`;
    if (action === 'uninstall') {
      if (!installed) return 0;
      if (linux) {
        await deps.exec('systemctl', ['--user', 'disable', '--now', 'bowcode.service']);
      } else {
        await deps.exec('launchctl', ['bootout', `${domain}/dev.bowcode`]);
      }
      deps.remove(unit);
      if (linux) await deps.exec('systemctl', ['--user', 'daemon-reload']);
      return 0;
    }
    const portIndex = args.indexOf('--port');
    const hostIndex = args.indexOf('--host');
    const port = portIndex === -1 ? '3001' : args[portIndex + 1];
    const host = hostIndex === -1 ? '0.0.0.0' : args[hostIndex + 1];
    if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !host || /[\n\r]/.test(host)) {
      deps.error('Invalid port or host');
      return 1;
    }
    deps.mkdir(path.dirname(unit));
    if (linux) {
      const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
      deps.write(unit, `# managed-by: bowcode\n[Unit]\nDescription=Bowcode server\n[Service]\nExecStart=${quote(deps.nodePath)} ${quote(deps.cliPath)} start\nEnvironment="SERVER_PORT=${port}"\nEnvironment="HOST=${host}"\nEnvironment="PATH=${deps.pathEnv}"\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n`);
      await deps.exec('systemctl', ['--user', 'daemon-reload']);
      await deps.exec('systemctl', ['--user', 'enable', '--now', 'bowcode.service']);
      deps.log('To keep the service running after logout, run: loginctl enable-linger $USER');
    } else {
      const logs = path.join(deps.home, '.bowcode/logs');
      deps.mkdir(logs);
      deps.write(unit, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>dev.bowcode</string>\n<key>ManagedBy</key><string>managed-by: bowcode</string>\n<key>ProgramArguments</key><array><string>${xml(deps.nodePath)}</string><string>${xml(deps.cliPath)}</string><string>start</string></array>\n<key>EnvironmentVariables</key><dict><key>SERVER_PORT</key><string>${xml(port)}</string><key>HOST</key><string>${xml(host)}</string><key>PATH</key><string>${xml(deps.pathEnv)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xml(path.join(logs, 'service.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(logs, 'service-error.log'))}</string>\n</dict></plist>\n`);
      await deps.exec('launchctl', ['bootstrap', domain, unit]);
    }
    return 0;
  };
}
