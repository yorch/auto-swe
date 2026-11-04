// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQuery } from '@/test/rtl-helpers';
import ResetPasswordPage from './page';

const resetPassword = vi.fn();
let token: string | null = 'tok-1';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: (key: string) => (key === 'token' ? token : null) }),
}));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { resetPassword: typeof resetPassword }) => unknown) =>
    selector({ resetPassword }),
}));

beforeEach(() => {
  token = 'tok-1';
  resetPassword.mockReset();
});
afterEach(() => vi.clearAllMocks());

function fields() {
  const inputs = document.querySelectorAll('input');
  return { confirm: inputs[1] as HTMLInputElement, password: inputs[0] as HTMLInputElement };
}

describe('/reset-password', () => {
  it('shows an error state instead of a dead form when the link has no token', async () => {
    token = null;
    render(withQuery(<ResetPasswordPage />));
    expect(await screen.findByText('This reset link is not valid')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeTruthy();
    expect(document.querySelector('form')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('turns a rejected token into the same error state, with the reason', async () => {
    resetPassword.mockRejectedValueOnce(new Error('Invalid token'));
    render(withQuery(<ResetPasswordPage />));
    const { password, confirm } = fields();
    fireEvent.change(password, { target: { value: 'correct-horse' } });
    fireEvent.change(confirm, { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('This reset link is not valid')).toBeTruthy();
    expect(screen.getByText(/already been used/)).toBeTruthy();
  });

  it('reports a short password in its own message, not the browser bubble', async () => {
    render(withQuery(<ResetPasswordPage />));
    const { password, confirm } = fields();
    fireEvent.change(password, { target: { value: 'short' } });
    fireEvent.change(confirm, { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('Use at least 8 characters.')).toBeTruthy();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('checks the confirmation when the field loses focus', async () => {
    render(withQuery(<ResetPasswordPage />));
    const { password, confirm } = fields();
    fireEvent.change(password, { target: { value: 'correct-horse' } });
    fireEvent.change(confirm, { target: { value: 'correct-hors' } });
    fireEvent.blur(confirm);
    expect(await screen.findByText('The passwords do not match.')).toBeTruthy();
  });

  it('toggles both fields between hidden and visible', () => {
    render(withQuery(<ResetPasswordPage />));
    const { password, confirm } = fields();
    expect(password.type).toBe('password');
    fireEvent.click(screen.getByLabelText('Show passwords'));
    expect(password.type).toBe('text');
    expect(confirm.type).toBe('text');
  });

  it('confirms success in a status region with a sign-in button and no timed redirect', async () => {
    resetPassword.mockResolvedValueOnce(undefined);
    render(withQuery(<ResetPasswordPage />));
    const { password, confirm } = fields();
    fireEvent.change(password, { target: { value: 'correct-horse' } });
    fireEvent.change(confirm, { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    await waitFor(() => expect(resetPassword).toHaveBeenCalledWith('tok-1', 'correct-horse'));
    expect((await screen.findByRole('status')).textContent).toContain('Password updated');
    expect(screen.getByRole('link', { name: 'Sign in now' })).toBeTruthy();
  });
});
