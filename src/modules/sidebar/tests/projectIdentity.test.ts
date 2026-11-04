import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { Project, SessionWithProvider } from '@/shared/types';
import { getProjectIdentity, getProjectSummary } from '@/modules/sidebar/utils/projectIdentity';

const project = { projectId: 'one', displayName: 'One', fullPath: '/work/one', sessionMeta: { total: 5 } } as Project;
const session = (summary: string, lastActivity: string): SessionWithProvider => ({
  id: summary, summary, lastActivity, __provider: 'claude',
});

test('project identity is deterministic across objects and display name changes', () => {
  const first = getProjectIdentity(project);
  const second = getProjectIdentity({ ...project, displayName: 'Renamed' });
  assert.equal(first.Icon, second.Icon);
  assert.equal(first.hue, second.hue);
  assert.ok(first.hue >= 0 && first.hue < 360);
  assert.deepEqual(getProjectIdentity({ ...project, fullPath: '', projectId: 'one' }),
    getProjectIdentity({ ...project, fullPath: '', projectId: 'one' }));
});

test('summary picks the latest activity, limits the title and includes total and age', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  assert.equal(getProjectSummary(project, [], now), 'No sessions yet');
  assert.equal(getProjectSummary(project, [
    session('Old', '2026-11-04T08:00:00Z'),
    session('Fix login bug', '2026-11-04T10:00:00Z'),
  ], now), 'Fix login bug · 5 · 2hr');
  assert.ok(getProjectSummary(project, [session('x'.repeat(80), '2026-11-04T12:00:00Z')], now).startsWith(`${'x'.repeat(59)}… · 5`));
});
