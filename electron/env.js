// New Bowcode environment variables take precedence over their legacy CloudCLI names.
export function desktopEnv(name, fallback = undefined) {
  return process.env[name] ?? process.env[name.replace(/^BOWCODE_/, 'CLOUDCLI_')] ?? fallback;
}
