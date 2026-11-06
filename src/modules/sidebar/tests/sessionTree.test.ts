import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { SessionWithProvider } from '@/shared/types';
import { buildSessionTree } from '@/modules/sidebar/utils/sessionTree';

const session = (id: string, parentSessionId?: string, lastActivity?: string): SessionWithProvider =>
  ({ id, parentSessionId, lastActivity } as SessionWithProvider);

const ids = (nodes: ReturnType<typeof buildSessionTree>) => nodes.map((node) => node.session.id);

test('preserves loaded order at each level and nests children recursively', () => {
  const tree = buildSessionTree([
    session('child-b', 'root'), session('other'), session('grandchild', 'child-b'),
    session('root'), session('child-a', 'root'), session('last'),
  ]);
  assert.deepEqual(ids(tree), ['other', 'root', 'last']);
  assert.deepEqual(ids(tree[1].children), ['child-b', 'child-a']);
  assert.deepEqual(ids(tree[1].children[0].children), ['grandchild']);
});

test('missing and unloaded parents leave sessions top-level', () => {
  assert.deepEqual(ids(buildSessionTree([session('orphan', 'not-loaded'), session('plain')])), ['orphan', 'plain']);
});

test('roots sort by latest activity in their subtree, children by their own activity', () => {
  const tree = buildSessionTree([
    session('older-parent', undefined, '2026-01-01'),
    session('newer-root', undefined, '2026-01-03'),
    session('older-child', 'older-parent', '2026-01-02'),
    session('newest-grandchild', 'older-child', '2026-01-05'),
    session('newer-child', 'older-parent', '2026-01-04'),
  ]);
  assert.deepEqual(ids(tree), ['older-parent', 'newer-root']);
  assert.deepEqual(ids(tree[0].children), ['newer-child', 'older-child']);
});

test('self and multi-session cycles stay visible at top level', () => {
  const tree = buildSessionTree([
    session('self', 'self'), session('a', 'b'), session('b', 'a'), session('descendant', 'a'),
  ]);
  assert.deepEqual(ids(tree), ['self', 'a', 'b']);
  assert.deepEqual(ids(tree[1].children), ['descendant']);
});
