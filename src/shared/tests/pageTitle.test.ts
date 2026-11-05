import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import { getPageTitle } from '@/shared/utils';

const project: Project = {
  projectId: 'project-1',
  displayName: 'My Project',
  fullPath: '/projects/my-project',
};

test('uses the selected session summary as the page title', () => {
  const session: ProjectSession = {
    id: 'session-1',
    summary: 'Fix browser tab title',
    __provider: 'claude',
  };

  assert.equal(getPageTitle(project, session), 'Fix browser tab title');
});

test('uses the selected session name as the page title', () => {
  const session: ProjectSession = {
    id: 'session-1',
    name: 'Session name',
    __provider: 'codex',
  };
  assert.equal(getPageTitle(project, session), 'Session name');
});

test('falls back to the project title when no session is selected', () => {
  assert.equal(getPageTitle(project, null), 'My Project - Bowcode');
});

test('falls back to the app title when no project or session is selected', () => {
  assert.equal(getPageTitle(null, null), 'Bowcode');
});
