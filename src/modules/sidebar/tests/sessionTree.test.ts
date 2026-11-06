import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { SessionWithProvider } from '@/shared/types';
import { buildSessionTree } from '@/modules/sidebar/utils/sessionTree';

const session = (id: string, parentSessionId?: string): SessionWithProvider =>
  ({ id, parentSessionId } as SessionWithProvider);

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

test('self and multi-session cycles stay visible at top level', () => {
  const tree = buildSessionTree([
    session('self', 'self'), session('a', 'b'), session('b', 'a'), session('descendant', 'a'),
  ]);
  assert.deepEqual(ids(tree), ['self', 'a', 'b']);
  assert.deepEqual(ids(tree[1].children), ['descendant']);
});
