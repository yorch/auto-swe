// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateUserModal } from './CreateUserModal';

// jsdom lacks HTMLDialogElement.showModal/close; the Modal primitive calls
// both inside a useEffect. Stub on the prototype so the effect doesn't crash.
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function withQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

/** Wires the modal's open prop to local state the way real consumers do. */
function ControlledHost({ onCloseSpy }: { onCloseSpy: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <CreateUserModal
      onClose={() => {
        setOpen(false);
        onCloseSpy();
      }}
      open={open}
    />
  );
}

function setupFetchMock(handlers: Record<string, (body?: unknown) => unknown>) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const handler = handlers[path];
    if (!handler) throw new Error(`No fetch mock for ${path}`);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return new Response(JSON.stringify(handler(body)), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('CreateUserModal', () => {
  it('with an explicit password: closes the modal directly (no secret reveal)', async () => {
    const onClose = vi.fn();
    const fetchSpy = setupFetchMock({
      '/api/v1/users': () => ({
        data: {
          email: 'sa@example.com',
          id: 'u1',
          isActive: true,
          role: 'ENGINEER',
          // Important: NO temporaryPassword field — admin provided their own
        },
      }),
    });

    render(withQuery(<ControlledHost onCloseSpy={onClose} />));

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'sa@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password \(optional\)/i), {
      target: { value: 'correct-horse-battery' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // Both <dialog>s are always in the DOM (controlled via the `open`
    // attribute) so check open-state, not text presence. The secret-reveal
    // dialog should never have opened because the response had no
    // temporaryPassword.
    const openDialogs = Array.from(document.querySelectorAll('dialog')).filter((d) =>
      d.hasAttribute('open')
    );
    expect(openDialogs).toHaveLength(0);

    // Verify the request shape
    const call = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/api/v1/users'));
    if (!call) throw new Error('expected a POST to /api/v1/users');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({
      email: 'sa@example.com',
      password: 'correct-horse-battery',
      role: 'ENGINEER',
    });
  });

  it('with auto-generated password: hands off to the secret-reveal modal before closing', async () => {
    const onClose = vi.fn();
    setupFetchMock({
      '/api/v1/users': () => ({
        data: {
          email: 'autogen@example.com',
          id: 'u2',
          isActive: true,
          role: 'LEAD',
          temporaryPassword: 'rnd-secret-once',
        },
      }),
    });

    render(withQuery(<ControlledHost onCloseSpy={onClose} />));

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'autogen@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^role$/i), { target: { value: 'LEAD' } });
    // Leave password field blank — gateway will auto-generate
    fireEvent.click(screen.getByRole('button', { name: /create user/i }));

    // First: the reveal modal appears with the plaintext password
    await waitFor(() => {
      expect(screen.getByText('rnd-secret-once')).toBeTruthy();
    });

    // Parent's onClose has NOT been called yet — we want the admin to see the
    // password first. This is the bug the dual-modal hand-off prevents:
    // closing too early would lose the only chance to copy the secret.
    expect(onClose).not.toHaveBeenCalled();

    // Dismiss the reveal — only NOW should the parent close fire
    fireEvent.click(screen.getByRole('button', { name: /i have it/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
