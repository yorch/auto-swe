// @vitest-environment jsdom

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
});
