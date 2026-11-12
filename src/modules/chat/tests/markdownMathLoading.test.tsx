import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';

const imports = vi.hoisted(() => ({ plugin: 0, css: 0 }));

vi.mock('rehype-katex', async (importOriginal) => {
  imports.plugin += 1;
  return importOriginal();
});
vi.mock('katex/dist/katex.min.css', () => {
  imports.css += 1;
  return {};
});

test('ordinary markdown and lone dollar signs do not request math assets', () => {
  const { rerender, container } = render(<Markdown>Ordinary prose, costs $5 and $7.</Markdown>);
  rerender(<Markdown>More prose and a code block: `plain`.</Markdown>);

  assert.equal(imports.plugin, 0);
  assert.equal(imports.css, 0);
  assert.equal(container.querySelector('.katex'), null);
});

test('math loads once for multiple messages, then renders with KaTeX', async () => {
  const first = render(<Markdown>{'Before $$x^2$$ after.'}</Markdown>);
  const second = render(<Markdown>{'Another $$y^2$$ formula.'}</Markdown>);

  await waitFor(() => {
    assert.ok(first.container.querySelector('.katex'));
    assert.ok(second.container.querySelector('.katex'));
  });
  assert.equal(imports.plugin, 1);
  assert.equal(imports.css, 1);
});

test('a settled streaming block gains KaTeX without changing its text', async () => {
  const { container, rerender } = render(
    <StreamingMarkdown content={'$$z^2$$\n\nStill streaming'} isStreaming />,
  );

  await waitFor(() => assert.ok(container.querySelector('.katex')));
  rerender(<StreamingMarkdown content={'$$z^2$$\n\nStill streaming more'} isStreaming />);

  assert.equal(container.querySelectorAll('.katex').length, 1);
});
