import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { ActionMenu } from '@/shared/ui/ActionMenu';

const onSelect = vi.fn();

function rect({ top, right, bottom }: { top: number; right: number; bottom: number }): DOMRect {
  return {
    x: right - 100,
    y: top,
    top,
    right,
    bottom,
    left: right - 100,
    width: 100,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function renderPortalMenu() {
  const unrelatedScroller = document.createElement('div');
  document.body.append(unrelatedScroller);
  const host = document.createElement('div');
  document.body.append(host);

  const result = render(
    <ActionMenu
      label="Actions"
      portal
      items={[{ key: 'edit', label: 'Edit', onSelect }]}
    />,
    { container: host },
  );

  return { ...result, host, unrelatedScroller };
}

beforeEach(() => {
  onSelect.mockReset();
});

test('clicking the trigger opens a portal menu', () => {
  const triggerRect = rect({ top: 80, right: 300, bottom: 120 });
  const { getByRole } = renderPortalMenu();
  vi.spyOn(getByRole('button', { name: 'Actions' }), 'getBoundingClientRect').mockReturnValue(triggerRect);

  fireEvent.click(getByRole('button', { name: 'Actions' }));

  assert.ok(screen.getByRole('menu'));
});

test('scrolling an unrelated element keeps the portal menu open', () => {
  const { getByRole, unrelatedScroller } = renderPortalMenu();
  vi.spyOn(getByRole('button', { name: 'Actions' }), 'getBoundingClientRect')
    .mockReturnValue(rect({ top: 80, right: 300, bottom: 120 }));
  fireEvent.click(getByRole('button', { name: 'Actions' }));

  fireEvent.scroll(unrelatedScroller);

  assert.ok(screen.getByRole('menu'));
});

test('document and trigger-ancestor scrolls keep the menu open and reposition it', () => {
  const { getByRole, host } = renderPortalMenu();
  const trigger = getByRole('button', { name: 'Actions' });
  const getTriggerRect = vi.spyOn(trigger, 'getBoundingClientRect');
  getTriggerRect.mockReturnValue(rect({ top: 80, right: 300, bottom: 120 }));
  fireEvent.click(trigger);
  const menu = screen.getByRole('menu');
  assert.equal(menu.style.top, '126px');
  assert.equal(menu.style.left, '40px');

  getTriggerRect.mockReturnValue(rect({ top: 140, right: 360, bottom: 180 }));
  fireEvent.scroll(document);
  assert.ok(screen.getByRole('menu'));
  assert.equal(menu.style.top, '186px');
  assert.equal(menu.style.left, '100px');

  getTriggerRect.mockReturnValue(rect({ top: 200, right: 420, bottom: 240 }));
  fireEvent.scroll(host);
  assert.ok(screen.getByRole('menu'));
  assert.equal(menu.style.top, '246px');
  assert.equal(menu.style.left, '160px');
});

test('resize keeps the portal menu open and repositions it', () => {
  const { getByRole } = renderPortalMenu();
  const trigger = getByRole('button', { name: 'Actions' });
  const getTriggerRect = vi.spyOn(trigger, 'getBoundingClientRect');
  getTriggerRect.mockReturnValue(rect({ top: 80, right: 300, bottom: 120 }));
  fireEvent.click(trigger);

  getTriggerRect.mockReturnValue(rect({ top: 160, right: 380, bottom: 200 }));
  fireEvent(window, new Event('resize'));

  const menu = screen.getByRole('menu');
  assert.equal(menu.style.top, '206px');
  assert.equal(menu.style.left, '120px');
});

test('document scroll closes the menu after its trigger is removed', () => {
  const { getByRole } = renderPortalMenu();
  const trigger = getByRole('button', { name: 'Actions' });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect({ top: 80, right: 300, bottom: 120 }));
  fireEvent.click(trigger);
  trigger.remove();

  fireEvent.scroll(document);

  assert.equal(screen.queryByRole('menu'), null);
});

test('outside mousedown closes the portal menu', () => {
  const { getByRole, unrelatedScroller } = renderPortalMenu();
  const trigger = getByRole('button', { name: 'Actions' });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect({ top: 80, right: 300, bottom: 120 }));
  fireEvent.click(trigger);

  fireEvent.mouseDown(unrelatedScroller);

  assert.equal(screen.queryByRole('menu'), null);
});

test('selecting an item runs its callback and closes the portal menu', () => {
  const { getByRole } = renderPortalMenu();
  const trigger = getByRole('button', { name: 'Actions' });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect({ top: 80, right: 300, bottom: 120 }));
  fireEvent.click(trigger);

  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));

  assert.equal(onSelect.mock.calls.length, 1);
  assert.equal(screen.queryByRole('menu'), null);
});
