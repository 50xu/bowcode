/** Reads a Bowcode configuration variable, falling back to its legacy CloudCLI name for existing installations. */
export function readEnv(name: `BOWCODE_${string}`): string | undefined {
  return process.env[name] ?? process.env[`CLOUDCLI_${name.slice('BOWCODE_'.length)}`];
}
