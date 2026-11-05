import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import SessionOptions from '@/modules/sidebar/SessionOptions';

const { pending } = vi.hoisted(() => ({ pending: { resolve: (_response: Response) => {}, generate: vi.fn() } }));
vi.mock('@/shared/api', async (original) => ({
  ...await original<Record<string, unknown>>(),
  api: { generateSessionTitle: (...args: unknown[]) => {
    pending.generate(...args);
    return new Promise<Response>((resolve) => { pending.resolve = resolve; });
  } },
}));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));
vi.mock('@/modules/sidebar/hooks/useProviderSessionIdCopy', () => ({
  useProviderSessionIdCopy: () => ({ copyState: 'idle', copyLabel: 'Copy ID', setOptionsOpen: () => {}, handleCopyAction: () => {}, isCopyPending: false, CopyStateIcon: () => null }),
}));

test('Generate title calls the API and shows loading until it completes', async () => {
  render(<SessionOptions sessionId="s1" sessionName="Old" provider="claude" projectId="project"
    isProcessing={false} isEditing={false} renameDraft="" onRenameDraftChange={() => {}}
    onStartEditingSession={() => {}} onCancelEditingSession={() => {}} onSaveEditingSession={() => {}}
    onDeleteSession={() => {}} t={((key: string) => key) as never} />);
  fireEvent.click(screen.getByRole('button', { name: /Session options for Old/ }));
  fireEvent.click(screen.getByText('sessions.generateTitle'));
  expect(pending.generate).toHaveBeenCalledWith('s1');
  expect(screen.getByText('sessions.generatingTitle')).toBeTruthy();
  pending.resolve(new Response(JSON.stringify({ data: { summary: 'New title' } }), { status: 200 }));
  await waitFor(() => expect(screen.getByText('sessions.generateTitle')).toBeTruthy());
});
