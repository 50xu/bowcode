import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionRetentionSettings } from '@/shared/types.js';

import { createSessionRetentionService } from '../session-retention.service.js';

type Dependencies = Parameters<typeof createSessionRetentionService>[0];
type Query = Parameters<Dependencies['findInactiveSessions']>[0];
type Candidate = ReturnType<Dependencies['findInactiveSessions']>['sessions'][number];

const NOW = new Date('2026-06-01T12:00:00.000Z');

function candidate(sessionId: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    sessionId,
    provider: 'claude',
    title: sessionId,
    projectPath: '/workspace/demo',
    projectName: null,
    isArchived: false,
    lastActivity: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Fake wiring that records every call. `candidates` stands in for the
 * database query: the fake honours `limit` and `excludeSessionIds` the way
 * the real query does, so batch and busy behaviour is observable.
 */
function harness(options: {
  settings?: Partial<SessionRetentionSettings>;
  candidates?: Candidate[];
  busy?: string[];
  busyAtAction?: string[];
  failDelete?: string[];
} = {}) {
  const config = new Map<string, string>();
  if (options.settings) {
    config.set('session_retention_settings', JSON.stringify(options.settings));
  }
  const calls = {
    queries: [] as Query[],
    archived: [] as string[],
    deleted: [] as string[],
    announced: [] as Array<{ ids: string[]; action: string }>,
  };
  const dependencies: Dependencies = {
    config: {
      get: (key) => config.get(key) ?? null,
      set: (key, value) => { config.set(key, value); },
    },
    findInactiveSessions: (query) => {
      calls.queries.push(query);
      const matching = (options.candidates ?? [])
        .filter((row) => !query.excludeSessionIds.includes(row.sessionId))
        .filter((row) => query.includeArchived || !row.isArchived);
      return { sessions: matching.slice(0, query.limit), total: matching.length };
    },
    listBusySessionIds: async () => options.busy ?? [],
    isSessionBusy: (sessionId) => (options.busyAtAction ?? []).includes(sessionId),
    archiveSession: async (sessionId) => { calls.archived.push(sessionId); },
    deleteSession: async (sessionId) => {
      if ((options.failDelete ?? []).includes(sessionId)) {
        throw new Error('disk error');
      }
      calls.deleted.push(sessionId);
      return { deletedFromDisk: true };
    },
    announceSessionsRemoved: (ids, action) => { calls.announced.push({ ids, action }); },
    now: () => NOW,
    logError: () => undefined,
  };
  return { service: createSessionRetentionService(dependencies), calls, config };
}

test('defaults are disabled archive after 30 days, protecting starred projects', () => {
  const { service } = harness();
  assert.deepEqual(service.getStatus(), {
    settings: { enabled: false, inactiveDays: 30, action: 'archive', skipStarredProjects: true },
    lastRun: null,
  });
});

test('a corrupted stored document falls back to the disabled defaults', () => {
  const { service, config } = harness();
  config.set('session_retention_settings', '{not json');
  assert.equal(service.getStatus().settings.enabled, false);
  config.set('session_retention_settings', JSON.stringify({ enabled: 'yes', inactiveDays: -4, action: 'nuke' }));
  assert.deepEqual(service.getStatus().settings, {
    enabled: false, inactiveDays: 30, action: 'archive', skipStarredProjects: true,
  });
});

test('updateSettings merges a patch over the stored settings and persists it', () => {
  const { service, config } = harness({ settings: { enabled: true, inactiveDays: 90 } });
  const { settings } = service.updateSettings({ action: 'delete' });
  assert.deepEqual(settings, { enabled: true, inactiveDays: 90, action: 'delete', skipStarredProjects: true });
  assert.deepEqual(JSON.parse(config.get('session_retention_settings') ?? '{}'), settings);
});

test('a scheduled pass is a no-op while disabled', async () => {
  const { service, calls, config } = harness({ candidates: [candidate('old')] });
  assert.equal(await service.runScheduledPass(), null);
  assert.equal(calls.queries.length, 0);
  assert.deepEqual(calls.archived, []);
  assert.equal(config.has('session_retention_last_run'), false);
});

test('the cutoff is now minus the configured days', async () => {
  const { service, calls } = harness({ settings: { enabled: true, inactiveDays: 7 } });
  const result = await service.runScheduledPass();
  assert.equal(calls.queries[0]?.cutoff.toISOString(), '2026-05-25T12:00:00.000Z');
  assert.equal(result?.cutoff, '2026-05-25T12:00:00.000Z');
});

test('archive goes through the archive path, never revisits archived sessions, and announces', async () => {
  const { service, calls } = harness({
    settings: { enabled: true, action: 'archive' },
    candidates: [candidate('a'), candidate('b'), candidate('already', { isArchived: true })],
  });
  const result = await service.runScheduledPass();
  assert.equal(calls.queries[0]?.includeArchived, false);
  assert.deepEqual(calls.archived, ['a', 'b']);
  assert.deepEqual(calls.deleted, []);
  assert.deepEqual(calls.announced, [{ ids: ['a', 'b'], action: 'archived' }]);
  assert.equal(result?.archived, 2);
  assert.equal(result?.deleted, 0);
});

test('delete goes through the delete path and includes archived sessions', async () => {
  const { service, calls } = harness({
    settings: { enabled: true, action: 'delete' },
    candidates: [candidate('a'), candidate('archived', { isArchived: true })],
  });
  const result = await service.runScheduledPass();
  assert.equal(calls.queries[0]?.includeArchived, true);
  assert.deepEqual(calls.deleted, ['a', 'archived']);
  assert.deepEqual(calls.archived, []);
  assert.deepEqual(calls.announced, [{ ids: ['a', 'archived'], action: 'deleted' }]);
  assert.equal(result?.deleted, 2);
  assert.equal(result?.deletedFromDisk, 2);
});

test('busy sessions are excluded from selection and re-checked before acting', async () => {
  const { service, calls } = harness({
    settings: { enabled: true },
    candidates: [candidate('running'), candidate('started-meanwhile'), candidate('idle')],
    busy: ['running'],
    busyAtAction: ['started-meanwhile'],
  });
  const result = await service.runScheduledPass();
  assert.deepEqual(calls.queries[0]?.excludeSessionIds, ['running']);
  assert.deepEqual(calls.archived, ['idle']);
  assert.equal(result?.skippedBusy, 1);
});

test('starred-project protection is passed through to the query', async () => {
  const { service, calls } = harness({ settings: { enabled: true, skipStarredProjects: false } });
  await service.runScheduledPass();
  assert.equal(calls.queries[0]?.skipStarredProjects, false);
});

test('one pass touches at most the batch limit and reports the remainder', async () => {
  const candidates = Array.from({ length: 130 }, (_, index) => candidate(`s${index}`));
  const { service, calls } = harness({ settings: { enabled: true }, candidates });
  const result = await service.runScheduledPass();
  assert.equal(calls.queries[0]?.limit, 100);
  assert.equal(calls.archived.length, 100);
  assert.equal(result?.remaining, 30);
});

test('a failing session is counted, logged and does not stop the pass', async () => {
  const { service, calls } = harness({
    settings: { enabled: true, action: 'delete' },
    candidates: [candidate('bad'), candidate('good')],
    failDelete: ['bad'],
  });
  const result = await service.runScheduledPass();
  assert.deepEqual(calls.deleted, ['good']);
  assert.equal(result?.failed, 1);
  assert.equal(result?.remaining, 1);
});

test('a manual run works while disabled and is recorded as the last run', async () => {
  const { service, calls } = harness({ candidates: [candidate('old')] });
  const result = await service.runNow();
  assert.equal(result.trigger, 'manual');
  assert.deepEqual(calls.archived, ['old']);
  assert.deepEqual(service.getStatus().lastRun, result);
});

test('nothing is announced when nothing was removed', async () => {
  const { service, calls } = harness({ settings: { enabled: true } });
  await service.runScheduledPass();
  assert.deepEqual(calls.announced, []);
});

test('a manual run while a pass is in flight is refused; a scheduled one is skipped', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = createSessionRetentionService({
    config: { get: () => JSON.stringify({ enabled: true }), set: () => undefined },
    findInactiveSessions: () => ({ sessions: [], total: 0 }),
    listBusySessionIds: async () => { await gate; return []; },
    isSessionBusy: () => false,
    archiveSession: async () => undefined,
    deleteSession: async () => ({ deletedFromDisk: false }),
    announceSessionsRemoved: () => undefined,
    now: () => NOW,
  });
  const first = slow.runScheduledPass();
  assert.equal(await slow.runScheduledPass(), null);
  await assert.rejects(slow.runNow(), { code: 'SESSION_RETENTION_IN_PROGRESS' });
  release();
  assert.notEqual(await first, null);
});

test('preview lists a sample with the full count and changes nothing', async () => {
  const candidates = Array.from({ length: 25 }, (_, index) => candidate(`s${index}`));
  const { service, calls } = harness({ settings: { inactiveDays: 14 }, candidates, busy: ['s0'] });
  const preview = await service.preview();
  assert.equal(preview.total, 24);
  assert.equal(preview.sessions.length, 20);
  assert.equal(preview.sessions[0]?.sessionId, 's1');
  assert.equal(preview.cutoff, '2026-05-18T12:00:00.000Z');
  assert.deepEqual(calls.archived, []);
  assert.deepEqual(calls.announced, []);
});
