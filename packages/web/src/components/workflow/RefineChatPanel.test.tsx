// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { RefineChatPanel } from './RefineChatPanel';

type Answer = { data: { version: number }; summary: string; warnings: string[] };
const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useTemplates', () => ({
  useRefineWorkflowTemplate: () => ({ isPending: false, mutateAsync }),
}));

beforeEach(() => {
  stubDialogPrototype();
  // jsdom has no layout, so no element scrolls.
  Element.prototype.scrollTo = vi.fn();
  mutateAsync.mockReset();
});
afterEach(cleanup);

describe('RefineChatPanel', () => {
  it('drops an answer that arrives after a close and reopen, but still reports the saved version', async () => {
    let resolve: (a: Answer) => void = () => {};
    mutateAsync.mockReturnValue(new Promise<Answer>((r) => (resolve = r)));
    const onSaved = vi.fn();
    const ui = (open: boolean) => (
      <RefineChatPanel onClose={() => {}} onSaved={onSaved} open={open} templateId="t1" />
    );
    const { rerender } = render(ui(true));
    fireEvent.change(screen.getByLabelText('Change request'), { target: { value: 'add a step' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('add a step')).toBeTruthy();

    rerender(ui(false));
    rerender(ui(true));
    await act(async () => {
      resolve({ data: { version: 7 }, summary: 'done', warnings: [] });
    });

    expect(onSaved).toHaveBeenCalledWith(7);
    expect(screen.queryByText(/Saved as version 7/)).toBeNull();
    expect(screen.queryByText('add a step')).toBeNull();
  });

  it('shows the answer when the panel stayed open', async () => {
    mutateAsync.mockResolvedValue({ data: { version: 3 }, summary: 'ok', warnings: [] });
    render(<RefineChatPanel onClose={() => {}} open templateId="t1" />);
    fireEvent.change(screen.getByLabelText('Change request'), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(screen.getByText(/Saved as version 3/)).toBeTruthy();
  });
});
