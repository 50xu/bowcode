import assert from 'node:assert/strict';

import { test } from 'vitest';

import { cadenceToCron, cronToCadence, describeScheduleCadence } from '@/modules/schedules/utils/scheduleCadence';
import type { CadencePreset } from '@/modules/schedules/utils/scheduleCadence';

const PRESETS: Array<[CadencePreset, string]> = [
  [{ type: 'hourly', everyHours: 1, minute: 15 }, '15 * * * *'],
  [{ type: 'hourly', everyHours: 4, minute: 0 }, '0 */4 * * *'],
  [{ type: 'daily', hour: 9, minute: 30 }, '30 9 * * *'],
  [{ type: 'weekdays', hour: 7, minute: 5 }, '5 7 * * 1-5'],
  [{ type: 'weekly', dayOfWeek: 0, hour: 18, minute: 0 }, '0 18 * * 0'],
];

test('every cadence preset round-trips through its cron expression', () => {
  for (const [preset, cron] of PRESETS) {
    assert.equal(cadenceToCron(preset), cron);
    assert.deepEqual(cronToCadence(cron), preset);
  }
});

test('an expression no preset produces stays a custom cadence, verbatim', () => {
  for (const cron of ['*/15 9-17 * * 1-5', '0 0 1 * *', '0 9 * * 1,3', '61 9 * * *']) {
    assert.deepEqual(cronToCadence(cron), { type: 'custom', cron });
    assert.equal(cadenceToCron({ type: 'custom', cron: ` ${cron} ` }), cron);
  }
});

test('cadences are described for the list', () => {
  const t = ((key: string, options?: Record<string, unknown>) => `${key}:${JSON.stringify(options ?? {})}`) as never;
  assert.match(
    describeScheduleCadence({ kind: 'cron', cronExpression: '5 7 * * 1-5', runAt: null, timezone: 'UTC' }, t),
    /^cadence\.weekdaysAt:.*07:05/,
  );
  assert.match(
    describeScheduleCadence({ kind: 'cron', cronExpression: '0 0 1 * *', runAt: null, timezone: 'UTC' }, t),
    /^cadence\.custom:.*0 0 1 \* \*/,
  );
});
