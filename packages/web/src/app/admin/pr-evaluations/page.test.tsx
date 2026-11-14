// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import PrEvaluationsPage from './page';

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/pr-evaluations',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = {
  autoMergeEnabled: true,
  badMerge: false,
  badMergeReason: null,
  baseBranch: 'main',
  briefAvailable: true,
  briefMarkdownLength: 120,
  closedAt: null,
  connection: { organizationName: 'acme', repoName: 'api' },
  connectionId: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-11-01T00:00:00Z',
  headSha: 'abc',
  id: 'eval-1',
  mergedAt: null,
  mode: 'auto',
  prNumber: 7,
  reasons: [],
  requiredApprovers: 1,
  riskClass: 'LOW',
  statusState: 'success',
  triggeredBy: 'push',
};

describe('PR evaluations page', () => {
  it('lists evaluations and links a row to its pull request', async () => {
    const spy = setupFetchMock({
      '/api/v1/pr-evaluations': () => ({ data: [row], meta: { limit: 30, offset: 0, total: 1 } }),
      '/api/v1/pull-requests': () => ({ data: [{ id: 'pr-uuid', prNumber: 7 }] }),
      '/api/v1/repositories': () => ({
        data: [
          { id: row.connectionId, organizationName: 'acme', repoName: 'api', type: 'git_repo' },
        ],
        meta: { limit: 100, offset: 0, total: 1 },
      }),
    });
    render(withQuery(<PrEvaluationsPage />));
    const link = await screen.findByRole('link', { name: /acme\/api #7/ });
    await waitFor(() => expect(link.getAttribute('href')).toBe('/pull-requests/pr-uuid'));
    expect(screen.getAllByText('LOW').length).toBeGreaterThan(0);
    expect(screen.getAllByText('auto-merge armed').length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalled();
  });
});
