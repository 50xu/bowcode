import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A live busy Claude CLI turn, consumed by the providers sessions poll. */
type LiveClaudeCliSession = {
  providerSessionId: string;
  startedAt: number;
};

/** A live CLI holder, consumed by the websocket guard and scheduled dispatcher. */
export type ExternalClaudeCliSession = {
  providerSessionId: string;
  pid: number;
  status: 'busy' | 'idle';
  startedAt: number;
  cwd: string;
};

type RegistryAccess = {
  registryDirectory?: string;
  readProcStat?: (pid: number) => Promise<string>;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
};

const registryDirectory = () => path.join(os.homedir(), '.claude', 'sessions');
const MAX_REGISTRY_FILES = 256;

function access(options: RegistryAccess) {
  return {
    directory: options.registryDirectory ?? registryDirectory(),
    readProcStat: options.readProcStat ?? ((pid: number) => fsp.readFile(`/proc/${pid}/stat`, 'utf8')),
    kill: options.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal)),
  };
}

// The comm field can contain ')' and spaces. The fields following its last ')'
// start with state and ppid; starttime is field 20 in that suffix.
function procFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
}

async function isRecordedProcessAlive(pid: number, procStart: unknown, options: RegistryAccess): Promise<boolean> {
  try {
    access(options).kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') return false;
  }
  if (process.platform !== 'linux' || typeof procStart !== 'string' || !procStart) return true;
  try {
    return procFields(await access(options).readProcStat(pid))[19] === procStart;
  } catch {
    return false;
  }
}

type RegistryRecord = {
  providerSessionId: string;
  pid: number;
  status: 'busy' | 'idle';
  startedAt: number;
  cwd: string;
  entrypoint: unknown;
  procStart: unknown;
};

async function readRecord(filePath: string, options: RegistryAccess): Promise<RegistryRecord | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') return null;
  const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const pid = typeof record.pid === 'number' ? record.pid : NaN;
  if (!providerSessionId || !Number.isInteger(pid) || pid <= 0 ||
      (record.status !== 'busy' && record.status !== 'idle')) return null;
  if (!(await isRecordedProcessAlive(pid, record.procStart, options))) return null;
  return {
    providerSessionId, pid, status: record.status,
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : Date.now(),
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
    entrypoint: record.entrypoint, procStart: record.procStart,
  };
}

async function readRegistry(options: RegistryAccess): Promise<RegistryRecord[]> {
  const directory = access(options).directory;
  let entries: string[];
  try {
    entries = await fsp.readdir(directory);
  } catch {
    return [];
  }
  const files = entries.filter((entry) => entry.endsWith('.json')).slice(0, MAX_REGISTRY_FILES);
  const records = await Promise.all(files.map((file) => readRecord(path.join(directory, file), options)));
  return records.filter((record): record is RegistryRecord => record !== null);
}

async function isExternal(record: RegistryRecord, options: RegistryAccess): Promise<boolean> {
  if (record.entrypoint !== 'claudecodeui' || process.platform !== 'linux') return true;
  try {
    return Number(procFields(await access(options).readProcStat(record.pid))[1]) !== process.pid;
  } catch {
    // Unknown parentage cannot establish server ownership.
    return true;
  }
}

/** Used by the providers sessions poll; preserves its busy-only behavior. */
export async function listBusyClaudeCliSessions(): Promise<LiveClaudeCliSession[]> {
  return (await readRegistry({})).filter((record) => record.status === 'busy')
    .map(({ providerSessionId, startedAt }) => ({ providerSessionId, startedAt }));
}

/** Used by websocket and scheduled messages to detect external holders of either status. */
export async function listExternalClaudeCliSessions(options: RegistryAccess = {}): Promise<ExternalClaudeCliSession[]> {
  const records = await readRegistry(options);
  const external = await Promise.all(records.map(async (record) => (await isExternal(record, options)) ? record : null));
  return external.filter((record): record is RegistryRecord => record !== null)
    .map(({ providerSessionId, pid, status, startedAt, cwd }) => ({ providerSessionId, pid, status, startedAt, cwd }));
}

/** Used by websocket and scheduled messages to find a live external holder. */
export async function findExternalClaudeCliSession(
  providerSessionId: string, options: RegistryAccess = {},
): Promise<ExternalClaudeCliSession | null> {
  return (await listExternalClaudeCliSessions(options)).find((session) => session.providerSessionId === providerSessionId) ?? null;
}

/**
 * Server-owned CLI processes (spawned by this server's SDK runs) that still
 * hold a session. Consulted right before a new run resumes the session: any
 * process found here belongs to an earlier run that should already be gone,
 * and leaving it alive means two agents working one session.
 */
export async function findOwnedClaudeCliSessions(
  providerSessionId: string, options: RegistryAccess = {},
): Promise<ExternalClaudeCliSession[]> {
  const records = (await readRegistry(options)).filter((record) => record.providerSessionId === providerSessionId);
  const owned = await Promise.all(records.map(async (record) => (await isExternal(record, options)) ? null : record));
  return owned.filter((record): record is RegistryRecord => record !== null)
    .map(({ providerSessionId: id, pid, status, startedAt, cwd }) => ({ providerSessionId: id, pid, status, startedAt, cwd }));
}

/** Used by websocket takeover; rechecks identity before signalling a process. */
export async function terminateExternalClaudeCliSession(
  session: ExternalClaudeCliSession, options: RegistryAccess = {},
): Promise<void> {
  return terminateRecordedSession(session, 'external', options);
}

/** Stops a leftover server-owned CLI process found by findOwnedClaudeCliSessions. */
export async function terminateOwnedClaudeCliSession(
  session: ExternalClaudeCliSession, options: RegistryAccess = {},
): Promise<void> {
  return terminateRecordedSession(session, 'owned', options);
}

async function terminateRecordedSession(
  session: ExternalClaudeCliSession, ownership: 'external' | 'owned', options: RegistryAccess,
): Promise<void> {
  const record = (await readRegistry(options)).find((candidate) =>
    candidate.pid === session.pid && candidate.providerSessionId === session.providerSessionId);
  const external = record ? await isExternal(record, options) : false;
  if (!record || external !== (ownership === 'external') || typeof record.procStart !== 'string' || !record.procStart) {
    throw new Error(`${ownership === 'external' ? 'External' : 'Leftover'} Claude process identity could not be verified.`);
  }
  const alive = () => isRecordedProcessAlive(record.pid, record.procStart, options);
  if (!(await alive())) throw new Error('External Claude process is no longer alive.');
  console.info(ownership === 'external' ? '[Chat] Taking over external Claude session' : '[Chat] Stopping leftover Claude process before a new run', { sessionId: session.providerSessionId, pid: session.pid });
  access(options).kill(session.pid, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await alive())) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (await alive()) {
    access(options).kill(session.pid, 'SIGKILL');
    if (await alive()) throw new Error('External Claude process did not exit after SIGKILL.');
  }
}
