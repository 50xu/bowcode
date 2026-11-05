import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import SidebarHeader from '@/modules/sidebar/SidebarHeader';

const t = ((key: string) => key) as never;

test('the Schedules button sits between Refresh and New project, and opens the schedules dialog', () => {
  const onOpenSchedules = vi.fn();
  render(
    <SidebarHeader
      isPWA={false}
      isMobile={false}
      isLoading={false}
      projectsCount={0}
      runningSessionsCount={0}
      archivedSessionsCount={0}
      isArchivedSessionsLoading={false}
      searchFilter=""
      onSearchFilterChange={() => {}}
      onClearSearchFilter={() => {}}
      searchMode="projects"
      onSearchModeChange={() => {}}
      onRefresh={() => {}}
      isRefreshing={false}
      onOpenSchedules={onOpenSchedules}
      onCreateProject={() => {}}
      onCollapseSidebar={() => {}}
      t={t}
    />,
  );

  // The desktop header's action buttons, in order.
  const titles = screen.getAllByRole('button')
    .map((button) => button.getAttribute('title'))
    .filter((title): title is string => Boolean(title));
  const refresh = titles.indexOf('tooltips.refresh');
  const schedules = titles.indexOf('tooltips.schedules');
  const create = titles.indexOf('tooltips.createProject');
  assert.ok(refresh >= 0 && refresh < schedules && schedules < create, titles.join(', '));

  fireEvent.click(screen.getAllByRole('button', { name: 'tooltips.schedules' })[0]);
  assert.equal(onOpenSchedules.mock.calls.length, 1);
});
