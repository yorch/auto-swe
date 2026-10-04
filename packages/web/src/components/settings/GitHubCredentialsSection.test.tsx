// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { GitHubCredentialsSection } from './GitHubCredentialsSection';

const REPO = {
  defaultBranch: 'main',
  id: 'c1',
  isActive: true,
  organizationName: 'acme',
  repoName: 'payments',
  type: 'git_repo',
};

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('GitHubCredentialsSection', () => {
  it('lists the saved tokens by repository and revokes one', async () => {
    let deleted = 0;
    setupFetchMock({
      'DELETE /api/v1/repositories/c1/credential': () => {
        deleted++;
        return {};
      },
      'GET /api/v1/repositories': () => ({
        data: [REPO],
        meta: { limit: 500, offset: 0, total: 1 },
      }),
      'GET /api/v1/repositories/credentials/mine': () => ({
        data: {
          credentials: [
            {
              connectionId: 'c1',
              createdAt: '2026-01-01T00:00:00Z',
              lastFour: 'ab12',
              updatedAt: '2026-01-02T00:00:00Z',
            },
          ],
          enabled: true,
        },
      }),
    });
    render(withQuery(<GitHubCredentialsSection />));
    expect(await screen.findByText('acme/payments')).toBeTruthy();
    expect(screen.getByText(/ending in …ab12/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' }).at(-1) as HTMLElement);
    await waitFor(() => expect(deleted).toBe(1));
  });

  it('renders nothing while the feature is off and nothing is saved', async () => {
    setupFetchMock({
      'GET /api/v1/repositories': () => ({ data: [], meta: { limit: 500, offset: 0, total: 0 } }),
      'GET /api/v1/repositories/credentials/mine': () => ({
        data: { credentials: [], enabled: false },
      }),
    });
    const { container } = render(withQuery(<GitHubCredentialsSection />));
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
