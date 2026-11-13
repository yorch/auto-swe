// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  data: null as null | { accountLogin: string; organizationId: string },
  error: null as Error | null,
  mutate: vi.fn(),
  replace: vi.fn(),
  search: '',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock('@/hooks/useOrganizationGithub', () => ({
  useClaimGithubInstallation: () => ({
    data: h.data,
    error: h.error,
    isError: Boolean(h.error),
    isPending: false,
    mutate: h.mutate,
  }),
}));

import CallbackPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  h.search = 'state=signed&code=code&installation_id=77';
  h.data = null;
  h.error = null;
});
afterEach(cleanup);
describe('GitHub installation callback', () => {
  it('claims only after confirmation', () => {
    render(<CallbackPage />);
    expect(h.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect installation' }));
    expect(h.mutate).toHaveBeenCalledWith({ code: 'code', installation_id: '77', state: 'signed' });
  });
  it('preserves the no-state admin post-install flow', async () => {
    h.search = 'installation_id=77&setup_action=install&code=unused';
    render(<CallbackPage />);
    await waitFor(() =>
      expect(h.replace).toHaveBeenCalledWith(
        '/admin/integrations?installation_id=77&setup_action=install'
      )
    );
    expect(h.mutate).not.toHaveBeenCalled();
  });
  it('refuses incomplete authorization', () => {
    h.search = 'state=signed&installation_id=77';
    render(<CallbackPage />);
    expect(screen.getByText(/did not complete installation authorization/)).toBeTruthy();
    expect(h.mutate).not.toHaveBeenCalled();
  });
  it('shows verification errors', () => {
    h.error = new Error('State expired');
    render(<CallbackPage />);
    expect(screen.getByText('State expired')).toBeTruthy();
  });
  it('links back to the organization after success', () => {
    h.data = { accountLogin: 'acme', organizationId: 'org' };
    render(<CallbackPage />);
    expect(screen.getByRole('link', { name: 'Return to organization' }).getAttribute('href')).toBe(
      '/admin/organizations/org'
    );
  });
});
