import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  scheduleRunsDb,
  schedulesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { executeScheduleRun } from '@/modules/schedules/services/schedule-runner.service.js';
import {
  closeScheduleScheduler,
  dispatchDueSchedules,
  initializeScheduleScheduler,
  markInterruptedRunsOnStartup,
  waitForScheduleRunsToSettle,
} from '@/modules/schedules/services/schedule-scheduler.service.js';
import schedulesRoutes from '@/modules/schedules/schedules.routes.js';
import { computeNextRunAt, schedulesService } from '@/modules/schedules/services/schedules.service.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import type { ScheduleWriteInput } from '@/shared/types.js';

type Fixture = { userId: number; projectId: string; projectPath: string };

async function withIsolatedDatabase(runTest: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'schedules-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('scheduler', 'hash');
    const project = projectsDb.createProjectPath(tempDirectory).project!;
    await runTest({ userId: Number(user.id), projectId: project.project_id, projectPath: project.project_path });
  } finally {
    await waitForScheduleRunsToSettle();
    closeScheduleScheduler();
    chatRunRegistry.clearAll();
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { provider: string; command: string; options: Record<string, unknown> };
type Writer = { send(message: unknown): void };

/**
 * A provider runtime gateway that records each run. `behaviour` decides how a
 * turn ends: `ok` completes with exit 0, `error` reports a provider error and
 * exits 1, `hang` waits until the run is aborted.
 */
function createRuntime(behaviour: 'ok' | 'error' | 'hang' = 'ok') {
  const runs: RunCall[] = [];
  const aborts: string[] = [];
  const releases = new Map<string, () => void>();
  const runtime = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    run: async (provider: string, command: string, options: Record<string, unknown>, writer: Writer) => {
      runs.push({ provider, command, options });
      if (behaviour === 'error') {
        writer.send({ kind: 'error', content: 'model overloaded', provider, sessionId: options.sessionId });
        writer.send({ kind: 'complete', exitCode: 1, provider, sessionId: options.sessionId });
        return;
      }
      if (behaviour === 'hang') {
        const sessionId = String(options.sessionId);
        await new Promise<void>((resolve) => releases.set(sessionId, resolve));
        // Released normally (not aborted): the turn finishes cleanly.
        if (!aborts.includes(sessionId)) {
          writer.send({ kind: 'complete', exitCode: 0, provider, sessionId });
        }
        return;
      }
      writer.send({ kind: 'complete', exitCode: 0, provider, sessionId: options.sessionId });
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      releases.get(sessionId)?.();
      return true;
    },
  };
  return {
    runtime: runtime as never,
    runs,
    aborts,
    /** Lets every hanging run finish normally. */
    releaseAll: () => releases.forEach((release) => release()),
  };
}

function cronInput(fixture: Fixture, overrides: ScheduleWriteInput = {}): ScheduleWriteInput {
  return {
    name: 'Nightly checks',
    projectId: fixture.projectId,
    provider: 'claude',
    prompt: 'run the nightly checks',
    kind: 'cron',
    cronExpression: '0 3 * * *',
    timezone: 'UTC',
    ...overrides,
  };
}

function setNextRunAt(scheduleId: string, nextRunAt: Date): void {
  getConnection().prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(nextRunAt.toISOString(), scheduleId);
}

async function withRoutes(userId: number, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number } }).user = { id: userId };
    next();
  });
  app.use('/api/schedules', schedulesRoutes);
  // Mirrors the app's error envelope closely enough to read status codes.
  app.use((error: { statusCode?: number; code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false, error: { code: error.code, message: error.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

// ─── Next-run computation ──────────────────────────────────────────────────

test('next run follows wall-clock time across a spring-forward DST change', () => {
  // 2026-03-08 02:30 does not exist in New York; the fire moves to 03:00 EDT,
  // and the next day is 02:30 EDT again (06:30Z), not 07:30Z.
  const base = { kind: 'cron' as const, cron_expression: '30 2 * * *', run_at: null, timezone: 'America/New_York' };
  const first = computeNextRunAt(base, new Date('2026-03-07T12:00:00Z'));
  assert.equal(first, '2026-03-08T07:00:00.000Z');
  assert.equal(computeNextRunAt(base, new Date(first!)), '2026-03-09T06:30:00.000Z');
});

test('next run keeps 09:00 local across a fall-back DST change', () => {
  const base = { kind: 'cron' as const, cron_expression: '0 9 * * 1-5', run_at: null, timezone: 'Europe/Berlin' };
  // Friday 23 Oct is CEST (UTC+2); Monday 26 Oct is CET (UTC+1).
  assert.equal(computeNextRunAt(base, new Date('2026-10-23T06:00:00Z')), '2026-10-23T07:00:00.000Z');
  assert.equal(computeNextRunAt(base, new Date('2026-10-23T08:00:00Z')), '2026-10-26T08:00:00.000Z');
});

test('the same expression fires at different instants in different time zones', () => {
  const at = new Date('2026-06-01T00:00:00Z');
  const tokyo = computeNextRunAt({ kind: 'cron', cron_expression: '0 9 * * *', run_at: null, timezone: 'Asia/Tokyo' }, at);
  const utc = computeNextRunAt({ kind: 'cron', cron_expression: '0 9 * * *', run_at: null, timezone: 'UTC' }, at);
  // 09:00 in Tokyo is midnight UTC; a fire exactly at `at` is not "after" it.
  assert.equal(tokyo, '2026-06-02T00:00:00.000Z');
  assert.equal(utc, '2026-06-01T09:00:00.000Z');
});

test('a one-off schedule has a next run only while its time is ahead', () => {
  const once = { kind: 'once' as const, cron_expression: null, run_at: '2026-06-01T10:00:00.000Z', timezone: 'UTC' };
  assert.equal(computeNextRunAt(once, new Date('2026-06-01T09:00:00Z')), '2026-06-01T10:00:00.000Z');
  assert.equal(computeNextRunAt(once, new Date('2026-06-01T10:00:00Z')), null);
});

// ─── Claiming and dispatch ─────────────────────────────────────────────────

test('claiming a due schedule advances next_run_at in the same transaction, so a second claim gets nothing', async () => {
  await withIsolatedDatabase((fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture));
    const now = new Date();
    setNextRunAt(schedule.id, new Date(now.getTime() - 10_000));

    const first = schedulesDb.claimDue(now, computeNextRunAt);
    const second = schedulesDb.claimDue(now, computeNextRunAt);

    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    const nextRunAt = schedulesDb.getById(schedule.id)!.next_run_at!;
    assert.ok(new Date(nextRunAt).getTime() > now.getTime());
  });
});

test('a due schedule runs in a brand-new session with the schedule settings and headless on', async () => {
  await withIsolatedDatabase(async (fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture, { model: 'claude-opus-5', effort: 'high' }));
    const now = new Date();
    setNextRunAt(schedule.id, new Date(now.getTime() - 5_000));
    const fake = createRuntime('ok');

    const pass = dispatchDueSchedules({ runtime: fake.runtime }, now);
    await waitForScheduleRunsToSettle();

    assert.deepEqual(pass, { claimed: 1, started: 1, skipped: 0 });
    assert.equal(fake.runs.length, 1);
    assert.equal(fake.runs[0].command, 'run the nightly checks');
    assert.equal(fake.runs[0].options.model, 'claude-opus-5');
    assert.equal(fake.runs[0].options.effort, 'high');
    assert.equal(fake.runs[0].options.permissionMode, 'auto');
    assert.equal(fake.runs[0].options.headless, true);

    const [run] = scheduleRunsDb.listForSchedule(schedule.id, 10);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.trigger, 'scheduled');
    assert.ok(run.session_id);
    const session = sessionsDb.getSessionById(run.session_id!);
    assert.ok(session?.custom_name?.startsWith('Nightly checks · '));
    assert.equal(schedulesDb.getById(schedule.id)!.last_status, 'succeeded');
  });
});

test('every run creates a new session', async () => {
  await withIsolatedDatabase(async (fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture));
    const row = schedulesDb.getById(schedule.id)!;
    const fake = createRuntime('ok');

    await executeScheduleRun({ schedule: row, trigger: 'manual', scheduledFor: null }, { runtime: fake.runtime });
    await executeScheduleRun({ schedule: row, trigger: 'manual', scheduledFor: null }, { runtime: fake.runtime });

    const runs = scheduleRunsDb.listForSchedule(schedule.id, 10);
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0].session_id, runs[1].session_id);
    assert.ok(runs.every((run) => run.session_id && sessionsDb.getSessionById(run.session_id)));
    assert.deepEqual(new Set(fake.runs.map((call) => call.options.sessionId)).size, 2);
  });
});

test('a fire missed while the server was down is recorded as skipped and not run', async () => {
  await withIsolatedDatabase(async (fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture));
    const now = new Date();
    setNextRunAt(schedule.id, new Date(now.getTime() - 3 * 60 * 60 * 1000));
    const fake = createRuntime('ok');

    const pass = dispatchDueSchedules({ runtime: fake.runtime }, now);
    await waitForScheduleRunsToSettle();

    assert.deepEqual(pass, { claimed: 1, started: 0, skipped: 1 });
    assert.equal(fake.runs.length, 0);
    const [run] = scheduleRunsDb.listForSchedule(schedule.id, 10);
    assert.equal(run.status, 'skipped');
    assert.match(run.error ?? '', /not running/);
    const row = schedulesDb.getById(schedule.id)!;
    assert.equal(row.enabled, 1);
    assert.ok(new Date(row.next_run_at!).getTime() > now.getTime());
  });
});

test('a one-off schedule whose time passed while down is skipped and disabled', async () => {
  await withIsolatedDatabase(async (fixture) => {
    const now = new Date();
    const schedule = schedulesService.create(fixture.userId, {
      ...cronInput(fixture),
      kind: 'once',
      cronExpression: null,
      runAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    const fake = createRuntime('ok');

    dispatchDueSchedules({ runtime: fake.runtime }, later);
    await waitForScheduleRunsToSettle();

    assert.equal(fake.runs.length, 0);
    const row = schedulesDb.getById(schedule.id)!;
    assert.equal(row.enabled, 0);
    assert.equal(row.next_run_at, null);
    assert.equal(scheduleRunsDb.listForSchedule(schedule.id, 10)[0].status, 'skipped');
  });
});

test('a fire while the same schedule is still running is skipped, not overlapped', async () => {
  await withIsolatedDatabase(async (fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture));
    const fake = createRuntime('hang');

    const firstNow = new Date();
    setNextRunAt(schedule.id, new Date(firstNow.getTime() - 1_000));
    dispatchDueSchedules({ runtime: fake.runtime }, firstNow);
    // Let the first run reach the provider.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondNow = new Date();
    setNextRunAt(schedule.id, new Date(secondNow.getTime() - 1_000));
    const pass = dispatchDueSchedules({ runtime: fake.runtime }, secondNow);

    assert.deepEqual(pass, { claimed: 1, started: 0, skipped: 1 });
    assert.equal(fake.runs.length, 1);
    fake.releaseAll();
    await waitForScheduleRunsToSettle();

    const statuses = scheduleRunsDb.listForSchedule(schedule.id, 10).map((run) => run.status).sort();
    assert.deepEqual(statuses, ['skipped', 'succeeded']);
  });
});

test('a run past its time limit is aborted and recorded as timed_out', async () => {
  await withIsolatedDatabase(async (fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture));
    const fake = createRuntime('hang');

    const status = await executeScheduleRun(
      { schedule: schedulesDb.getById(schedule.id)!, trigger: 'manual', scheduledFor: null },
      { runtime: fake.runtime, maxDurationMs: 30 },
    );

    assert.equal(status, 'timed_out');
    const [run] = scheduleRunsDb.listForSchedule(schedule.id, 10);
    assert.equal(run.status, 'timed_out');
    assert.deepEqual(fake.aborts, [run.session_id]);
    assert.equal(chatRunRegistry.isProcessing(run.session_id!), false);
  });
});

test('a turn that reports a provider error is recorded as failed', async () => {
  await withIsolatedDatabase(async (fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture));
    const fake = createRuntime('error');

    const status = await executeScheduleRun(
      { schedule: schedulesDb.getById(schedule.id)!, trigger: 'manual', scheduledFor: null },
      { runtime: fake.runtime },
    );

    assert.equal(status, 'failed');
    const [run] = scheduleRunsDb.listForSchedule(schedule.id, 10);
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'model overloaded');
    assert.equal(schedulesDb.getById(schedule.id)!.last_status, 'failed');
  });
});

test('startup marks runs left running by the previous process as interrupted', async () => {
  await withIsolatedDatabase((fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture));
    const run = scheduleRunsDb.create({ scheduleId: schedule.id, trigger: 'scheduled', scheduledFor: null, status: 'running' });
    schedulesDb.recordLastRun(schedule.id, 'running', run.started_at);

    assert.equal(markInterruptedRunsOnStartup(), 1);

    assert.equal(scheduleRunsDb.getById(run.id)!.status, 'interrupted');
    assert.ok(scheduleRunsDb.getById(run.id)!.finished_at);
    assert.equal(schedulesDb.getById(schedule.id)!.last_status, 'interrupted');
  });
});

test('run history keeps only the newest 50 runs', async () => {
  await withIsolatedDatabase(async (fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture));
    for (let index = 0; index < 55; index += 1) {
      scheduleRunsDb.create({
        scheduleId: schedule.id,
        trigger: 'scheduled',
        scheduledFor: null,
        status: 'skipped',
        startedAt: new Date(Date.now() - (60 - index) * 60_000),
      });
    }
    await executeScheduleRun(
      { schedule: schedulesDb.getById(schedule.id)!, trigger: 'manual', scheduledFor: null },
      { runtime: createRuntime('ok').runtime },
    );
    assert.equal(scheduleRunsDb.listForSchedule(schedule.id, 100).length, 50);
  });
});

// ─── Validation and routes ─────────────────────────────────────────────────

test('schedule validation refuses bad cron, too-frequent cron, bad zone, plan mode, empty prompt and unknown projects', async () => {
  await withIsolatedDatabase(async (fixture) => {
    await withRoutes(fixture.userId, async (baseUrl) => {
      const post = (body: unknown) => fetch(`${baseUrl}/api/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const codeOf = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code;

      let response = await post(cronInput(fixture, { cronExpression: 'not a cron' }));
      assert.equal(response.status, 400);
      assert.equal(await codeOf(response), 'INVALID_CRON');

      response = await post(cronInput(fixture, { cronExpression: '*/2 * * * *' }));
      assert.equal(response.status, 400);
      assert.equal(await codeOf(response), 'SCHEDULE_TOO_FREQUENT');

      response = await post(cronInput(fixture, { timezone: 'Mars/Olympus' }));
      assert.equal(response.status, 400);
      assert.equal(await codeOf(response), 'INVALID_TIMEZONE');

      response = await post(cronInput(fixture, { permissionMode: 'plan' }));
      assert.equal(response.status, 400);
      assert.equal(await codeOf(response), 'INVALID_PERMISSION_MODE');

      // Codex does not support auto.
      response = await post(cronInput(fixture, { provider: 'codex', permissionMode: 'auto' }));
      assert.equal(response.status, 400);

      response = await post(cronInput(fixture, { prompt: '   ' }));
      assert.equal(response.status, 400);
      assert.equal(await codeOf(response), 'PROMPT_REQUIRED');

      response = await post(cronInput(fixture, { projectId: 'missing-project' }));
      assert.equal(response.status, 404);

      response = await post({ ...cronInput(fixture), provider: 'gemini' });
      assert.equal(response.status, 400);

      response = await post(cronInput(fixture, { cronExpression: '*/5 * * * *' }));
      assert.equal(response.status, 201);
      const created = ((await response.json()) as { data: { permissionMode: string; enabled: boolean } }).data;
      assert.equal(created.permissionMode, 'auto');
      assert.equal(created.enabled, true);

      // A provider without auto falls back to its own default mode.
      response = await post(cronInput(fixture, { provider: 'codex' }));
      assert.equal(response.status, 201);
      assert.equal(((await response.json()) as { data: { permissionMode: string } }).data.permissionMode, 'default');
    });
  });
});

test('preview returns the next five fires and refuses an invalid expression', async () => {
  await withIsolatedDatabase(async (fixture) => {
    await withRoutes(fixture.userId, async (baseUrl) => {
      const preview = (body: unknown) => fetch(`${baseUrl}/api/schedules/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const ok = await preview({ cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' });
      assert.equal(ok.status, 200);
      const nextRuns = ((await ok.json()) as { data: { nextRuns: string[] } }).data.nextRuns;
      assert.equal(nextRuns.length, 5);
      assert.ok(nextRuns.every((fire, index) => index === 0 || fire > nextRuns[index - 1]));

      assert.equal((await preview({ cron: '* * * * *', timezone: 'UTC' })).status, 400);
    });
  });
});

test('run-now starts a run without moving next_run_at, and pause/resume/delete work', async () => {
  await withIsolatedDatabase(async (fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture));
    const nextRunAt = schedulesDb.getById(schedule.id)!.next_run_at;
    const fake = createRuntime('ok');
    initializeScheduleScheduler(fake.runtime);

    await withRoutes(fixture.userId, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/schedules/${schedule.id}/run-now`, { method: 'POST' });
      assert.equal(response.status, 202);
      await waitForScheduleRunsToSettle();

      assert.equal(fake.runs.length, 1);
      assert.equal(schedulesDb.getById(schedule.id)!.next_run_at, nextRunAt);
      const runs = ((await (await fetch(`${baseUrl}/api/schedules/${schedule.id}/runs`)).json()) as {
        data: Array<{ trigger: string; status: string; sessionId: string | null }>;
      }).data;
      assert.equal(runs.length, 1);
      assert.equal(runs[0].trigger, 'manual');
      assert.equal(runs[0].status, 'succeeded');
      assert.ok(runs[0].sessionId);

      const paused = await fetch(`${baseUrl}/api/schedules/${schedule.id}/pause`, { method: 'POST' });
      assert.equal(((await paused.json()) as { data: { enabled: boolean; nextRunAt: string | null } }).data.enabled, false);
      assert.equal(schedulesDb.getById(schedule.id)!.next_run_at, null);

      const resumed = await fetch(`${baseUrl}/api/schedules/${schedule.id}/resume`, { method: 'POST' });
      assert.ok(((await resumed.json()) as { data: { nextRunAt: string | null } }).data.nextRunAt);

      const detail = await fetch(`${baseUrl}/api/schedules/${schedule.id}`);
      assert.equal(((await detail.json()) as { data: { recentRuns: unknown[] } }).data.recentRuns.length, 1);

      const listed = await fetch(`${baseUrl}/api/schedules?projectId=${encodeURIComponent(fixture.projectId)}`);
      assert.equal(((await listed.json()) as { data: unknown[] }).data.length, 1);

      assert.equal((await fetch(`${baseUrl}/api/schedules/${schedule.id}`, { method: 'DELETE' })).status, 200);
      assert.equal(schedulesDb.getById(schedule.id), null);
      assert.equal((await fetch(`${baseUrl}/api/schedules/${schedule.id}/run-now`, { method: 'POST' })).status, 404);
    });
  });
});

test('another user cannot read or change a schedule', async () => {
  await withIsolatedDatabase(async (fixture) => {
    const schedule = schedulesService.create(fixture.userId, cronInput(fixture));
    const other = Number(userDb.createUser('someone-else', 'hash').id);
    await withRoutes(other, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/api/schedules/${schedule.id}`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/schedules/${schedule.id}`, { method: 'DELETE' })).status, 404);
    });
  });
});
