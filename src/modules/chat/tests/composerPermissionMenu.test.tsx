import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import { test } from 'vitest';

import type { PermissionMode } from '@/shared/types';
import { i18n } from '@/modules/i18n';
import frChat from '@/modules/i18n/locales/fr/chat.json';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';
import { PromptInputFooter, PromptInputTools } from '@/modules/chat/composer/PromptInput';

/**
 * The permission control used to be a bare icon, so nothing on screen said
 * which mode the next message would run in — plan mode included, which reads
 * as "nothing will be changed" and is the one users most need to see.
 */

const MODES = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'] as const;

test('the composer names the mode the next message runs in', () => {
  const { getByRole } = render(
    <ComposerPermissionMenu
      permissionMode="plan"
      permissionModes={[...MODES]}
      onSelectPermissionMode={() => {}}
      providerLabel="Claude"
    />,
  );

  assert.match(getByRole('button').textContent ?? '', /Plan Mode/);
});

test('a screen reader hears the mode the button shows', () => {
  const { getByRole } = render(
    <ComposerPermissionMenu
      permissionMode="plan"
      permissionModes={[...MODES]}
      onSelectPermissionMode={() => {}}
      providerLabel="Claude"
    />,
  );

  assert.ok(getByRole('button', { name: /^Plan Mode/ }));
});

test('the default mode is named too', () => {
  const { getByRole } = render(
    <ComposerPermissionMenu
      permissionMode="default"
      permissionModes={[...MODES]}
      onSelectPermissionMode={() => {}}
      providerLabel="Claude"
    />,
  );

  assert.match(getByRole('button').textContent ?? '', /Default Mode/);
});

const renderMenu = (permissionMode: PermissionMode, permissionModes: PermissionMode[] = [...MODES]) =>
  render(
    <ComposerPermissionMenu
      permissionMode={permissionMode}
      permissionModes={permissionModes}
      onSelectPermissionMode={() => {}}
      providerLabel="Claude"
    />,
  );

test('every mode leads the accessible name, a mode with no translation by its id', () => {
  // A provider may report a mode this menu has no name for; it is named by its id.
  const unknownMode = 'dontAsk' as PermissionMode;
  const expected: Array<[PermissionMode, string]> = [
    ['default', 'Default Mode'],
    ['auto', 'Auto Mode'],
    ['acceptEdits', 'Accept Edits'],
    ['bypassPermissions', 'Bypass Permissions'],
    ['plan', 'Plan Mode'],
    [unknownMode, 'dontAsk'],
  ];

  for (const [mode, name] of expected) {
    const { getByRole, unmount } = renderMenu(mode, [...MODES, unknownMode]);
    const trigger = getByRole('button', { name: new RegExp(`^${name}: `) });
    assert.equal(trigger.textContent, name);
    unmount();
  }
});

// Since the single-row footer (d628272) the name is no longer fitted to the
// composer's measured width: it is a CSS breakpoint. Below `sm` the trigger is
// a 36px icon so the model name keeps its room; from `sm` up it widens and the
// name shows. jsdom applies no Tailwind, so these tests read the classes that
// carry that contract.
const nameOf = (trigger: HTMLElement) => {
  const name = trigger.querySelector('span');
  assert.ok(name, 'the trigger renders the mode name');
  return name;
};

const renderInFooter = (permissionMode: PermissionMode) =>
  render(
    <PromptInputFooter>
      <PromptInputTools />
      <ComposerPermissionMenu
        permissionMode={permissionMode}
        permissionModes={[...MODES]}
        onSelectPermissionMode={() => {}}
        providerLabel="Claude"
      />
    </PromptInputFooter>,
  );

test('the mode is named where the composer has room, and only the icon is left where it does not', () => {
  const { getByRole } = renderInFooter('default');
  const trigger = getByRole('button', { name: /^Default Mode: / });
  const name = nameOf(trigger);

  assert.equal(name.textContent, 'Default Mode');
  // Phones: the name is hidden and the trigger is an icon-sized circle.
  assert.ok(name.classList.contains('hidden'), 'the name is hidden below the sm breakpoint');
  assert.ok(trigger.classList.contains('w-9'), 'the trigger is icon-sized below the sm breakpoint');
  // From sm up: the name shows and the trigger grows to fit it.
  assert.ok(name.classList.contains('sm:inline'), 'the name shows from the sm breakpoint');
  assert.ok(trigger.classList.contains('sm:w-auto'), 'the trigger widens for the name from the sm breakpoint');
  assert.ok(name.classList.contains('truncate'), 'a long name is truncated rather than pushing the send button out');
});

test('plan mode keeps its name wherever it fits inside the composer', () => {
  // Plan mode is named under the same rule as every other mode: from sm up,
  // and the accessible name says which mode on every width.
  for (const [mode, label] of [['plan', 'Plan Mode'], ['default', 'Default Mode']] as const) {
    const view = renderInFooter(mode);
    const trigger = view.getByRole('button', { name: new RegExp(`^${label}: `) });
    const name = nameOf(trigger);
    assert.equal(name.textContent, label);
    assert.ok(name.classList.contains('hidden') && name.classList.contains('sm:inline'), `${mode} follows the sm breakpoint`);
    view.unmount();
  }
});

test('typing the first character neither takes the name away nor brings it in', () => {
  // A keystroke re-renders the composer, and the clear button joins the
  // left-hand tools. Neither may change whether the mode is named.
  const view = renderInFooter('default');
  const name = nameOf(view.getByRole('button'));
  const classesBefore = name.className;

  view.rerender(
    <PromptInputFooter>
      <PromptInputTools>
        <button type="button" aria-label="Clear input" />
      </PromptInputTools>
      <ComposerPermissionMenu
        permissionMode="default"
        permissionModes={[...MODES]}
        onSelectPermissionMode={() => {}}
        providerLabel="Claude"
      />
    </PromptInputFooter>,
  );

  const after = nameOf(view.getByRole('button', { name: /^Default Mode: / }));
  assert.equal(after.textContent, 'Default Mode');
  assert.equal(after.className, classesBefore);
});

test('the trigger and the menu speak the user\'s language', async () => {
  await act(async () => {
    await i18n.changeLanguage('fr');
  });
  try {
    const { getByRole, getAllByRole } = renderMenu('plan');
    const trigger = getByRole('button');
    const heading = frChat.composer.permissionHeading.replace('{{provider}}', 'Claude');

    assert.equal(trigger.textContent, frChat.codex.modes.plan);
    assert.equal(
      trigger.getAttribute('aria-label'),
      frChat.composer.permissionTriggerLabel.replace('{{mode}}', frChat.codex.modes.plan).replace('{{heading}}', heading),
    );
    assert.match(trigger.getAttribute('aria-label') ?? '', /^Mode planification : /);

    fireEvent.click(trigger);
    const rows = getAllByRole('menuitemradio');
    assert.equal(rows.length, MODES.length);
    MODES.forEach((mode, index) => {
      assert.ok(rows[index].textContent?.startsWith(frChat.codex.modes[mode]), `${mode} row is in French`);
    });
    assert.equal(getByRole('menu').lastElementChild?.textContent, frChat.composer.permissionCycleHint);
  } finally {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  }
});

test('the menu ends by saying Tab in the message box switches modes', () => {
  const { getByRole } = renderMenu('default');
  fireEvent.click(getByRole('button'));

  assert.equal(getByRole('menu').lastElementChild?.textContent, 'Press Tab in the message box to switch modes');
});
