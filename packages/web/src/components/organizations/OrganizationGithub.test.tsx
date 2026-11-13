// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  isError: false,
  retire: vi.fn(),
  rows: [] as { id: string; accountLogin: string; installationId: string; isActive: boolean }[],
}));
vi.mock('@/hooks/useOrganizationGithub', () => ({
  useOrganizationGithub: () => ({
    connect: { mutateAsync: h.connect },
    installations: { data: h.rows, isError: h.isError },
    retire: { mutateAsync: h.retire },
  }),
}));

import { OrganizationGithub } from './OrganizationGithub';

beforeEach(() => {
  vi.clearAllMocks();
  stubDialogPrototype();
  h.isError = false;
  h.rows = [];
});
afterEach(cleanup);
describe('organization GitHub section', () => {
  it('offers connect and an empty state', () => {
    render(<OrganizationGithub orgId="org" />);
    expect(screen.getByRole('button', { name: 'Connect a GitHub org' })).toBeTruthy();
    expect(screen.getByText('No linked installations.')).toBeTruthy();
  });
  it('shows a connect failure', async () => {
    h.connect.mockRejectedValue(new Error('App is not configured'));
    render(<OrganizationGithub orgId="org" />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect a GitHub org' }));
    expect(await screen.findByText('App is not configured')).toBeTruthy();
  });
  it('confirms retirement and never offers reactivation', async () => {
    h.rows = [
      { accountLogin: 'acme', id: 'id', installationId: '123', isActive: true },
      { accountLogin: 'old', id: 'retired', installationId: '2', isActive: false },
    ];
    h.retire.mockResolvedValue({});
    render(<OrganizationGithub orgId="org" />);
    fireEvent.click(screen.getByRole('button', { name: 'Retire acme' }));
    expect(h.retire).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(h.retire).toHaveBeenCalledWith('id'));
    expect(screen.queryByRole('button', { name: /Reactivate/ })).toBeNull();
  });
  it('shows listing errors', () => {
    h.isError = true;
    render(<OrganizationGithub orgId="org" />);
    expect(screen.getByText('Could not load GitHub installations.')).toBeTruthy();
  });
});
