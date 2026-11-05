/** Reads a desktop configuration variable, using the given default when absent. */
export function desktopEnv(name, fallback = undefined) {
  return process.env[name] ?? fallback;
}
