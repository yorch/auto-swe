// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { TeamBudgetRequestDialog } from './TeamBudgetRequestDialog';

beforeEach(stubDialogPrototype);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDialog(onClose = vi.fn()) {
  render(withQuery(<TeamBudgetRequestDialog onClose={onClose} open teamId="t-1" />));
  return onClose;
}

function failWith(status: number, code: string, message: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code, message } }), {
          headers: { 'content-type': 'application/json' },
          status,
        })
    )
  );
}

describe('TeamBudgetRequestDialog', () => {
  it('keeps Send disabled until there is a reason, and counts the characters', () => {
    renderDialog();
    const send = screen.getByRole('button', { name: 'Send request' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('0/500')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Launch month' } });
    expect(screen.getByText('12/500')).toBeTruthy();
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '   ' } });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it('limits the reason to 500 characters', () => {
    renderDialog();
    expect(screen.getByLabelText('Reason').getAttribute('maxlength')).toBe('500');
  });

  it('sends the trimmed reason and confirms', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/teams/t-1/budget-requests': () => ({ data: { id: 'b1' } }),
    });
    renderDialog();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Launch month  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('Request sent.')).toBeTruthy();
    expect(bodyOf(spy, '/api/v1/teams/t-1/budget-requests')).toEqual({ reason: 'Launch month' });
  });

  it('says a request is already pending on a 409', async () => {
    failWith(409, 'REQUEST_PENDING', 'raw server text');
    renderDialog();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Launch month' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('A request is already pending for this team.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Request sent.')).toBeNull());
  });

  describe('lifecycle', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function tree(open: boolean, returnFocus?: () => HTMLElement | null, onClose = vi.fn()) {
      return (
        <QueryClientProvider client={qc}>
          <TeamBudgetRequestDialog
            onClose={onClose}
            open={open}
            returnFocus={returnFocus}
            teamId="t-1"
          />
        </QueryClientProvider>
      );
    }

    it('starts empty when reopened after a reason was typed', () => {
      const { rerender } = render(tree(true));
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Launch month' } });
      rerender(tree(false));
      rerender(tree(true));
      expect((screen.getByLabelText('Reason') as HTMLTextAreaElement).value).toBe('');
    });

    it('shows the form again, not Request sent, when reopened after a send', async () => {
      setupFetchMock({
        'POST /api/v1/teams/t-1/budget-requests': () => ({ data: { id: 'b1' } }),
      });
      const { rerender } = render(tree(true));
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Launch month' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
      await screen.findByText('Request sent.');
      rerender(tree(false));
      rerender(tree(true));
      expect(screen.queryByText('Request sent.')).toBeNull();
      expect(screen.getByLabelText('Reason')).toBeTruthy();
    });

    it('cannot be dismissed while the request is pending', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>(() => undefined))
      );
      render(tree(true));
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Launch month' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
      await screen.findByRole('button', { name: 'Sending…' });
      expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
        true
      );
      expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
        true
      );
      const dialog = document.querySelector('dialog') as HTMLDialogElement;
      const cancel = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(cancel);
      expect(cancel.defaultPrevented).toBe(true);
    });

    it('refreshes the pending requests once sent', async () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      setupFetchMock({
        'POST /api/v1/teams/t-1/budget-requests': () => ({ data: { id: 'b1' } }),
      });
      render(tree(true));
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Launch month' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
      await screen.findByText('Request sent.');
      expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual([
        'team-budget-requests',
        't-1',
      ]);
    });

    it('returns focus to the trigger when it closes', () => {
      const withTrigger = (open: boolean) => (
        <>
          <button id="trigger" type="button">
            Request a change
          </button>
          {tree(open, () => document.getElementById('trigger'))}
        </>
      );
      const { rerender } = render(withTrigger(true));
      rerender(withTrigger(false));
      expect(document.activeElement).toBe(document.getElementById('trigger'));
    });

    it('does not say an admin is notified', () => {
      render(tree(true));
      expect(
        screen.getByText('Team and organization admins see it in Settings, Budget.')
      ).toBeTruthy();
    });
  });
});
