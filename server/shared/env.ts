/** Reads a Bowcode configuration variable for server modules. */
export function readEnv(name: `BOWCODE_${string}`): string | undefined {
  return process.env[name];
}
