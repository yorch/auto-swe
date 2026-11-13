// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const h = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useAdmin', () => ({
  useOrganizationDirectory: () => ({ data: [{ id: 'org', name: 'Acme' }] }),
}));
vi.mock('@/hooks/useGithubInstallations', () => ({
  useCreateGithubInstallation: () => ({ mutateAsync: vi.fn() }),
  useDeleteGithubInstallation: () => ({ mutateAsync: vi.fn() }),
  useGithubInstallations: () => ({
    data: [
      {
        accountLogin: 'github-org',
        host: '',
        id: 'id',
        installationId: '77',
        isActive: true,
        organizationId: null,
      },
    ],
    isLoading: false,
    refetch: vi.fn(),
  }),
  useInstallationLinkImpact: () => ({
    data: { outsideOrganizationConnectionCount: 3 },
    isSuccess: true,
  }),
  useUpdateGithubInstallation: () => ({ mutateAsync: h.update }),
}));

import InstallationsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  stubDialogPrototype();
  h.update.mockResolvedValue({});
});
afterEach(cleanup);
describe('platform installation linking', () => {
  it('previews outside-org repositories and confirms before linking', async () => {
    render(<InstallationsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: /Organization/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Acme' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/3 repositories used by teams outside/)).toBeTruthy();
    expect(h.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change organization' }));
    await waitFor(() =>
      expect(h.update).toHaveBeenCalledWith({
        body: { accountLogin: 'github-org', isActive: true, organizationId: 'org' },
        id: 'id',
      })
    );
  });
});
