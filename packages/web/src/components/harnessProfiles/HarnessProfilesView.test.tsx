// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessProfileSummary } from '@/hooks/useHarnessProfiles';

const { check, patch, state } = vi.hoisted(() => ({
  check: vi.fn(),
  patch: vi.fn(),
  state: {
    rows: [] as unknown[],
    usage: new Map<string, { enabledTeams: number; stranded: number }>(),
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useHarnessProfiles', () => ({
  useCheckProfile: () => ({ isPending: false, mutateAsync: check }),
  useHarnessProfiles: () => ({ data: state.rows, error: null, isError: false, isLoading: false }),
  usePatchProfile: () => ({ isPending: false, mutateAsync: patch }),
  useProfileUsage: () => state.usage,
}));
vi.mock('./AddProfileModal', () => ({
  AddProfileModal: ({ open }: { open: boolean }) => (open ? <div>add-modal</div> : null),
}));
vi.mock('./ProfileDetailModal', () => ({
  ProfileDetailModal: ({ name }: { name: string | null }) =>
    name ? <div>detail-modal:{name}</div> : null,
}));

const { HarnessProfilesView } = await import('./HarnessProfilesView');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const profile = (over: Partial<HarnessProfileSummary>): HarnessProfileSummary => ({
  createdAt: '2026-10-01T00:00:00Z',
  description: 'desc',
  hooksEnabled: false,
  host: 'github.com',
  id: 'p1',
  lastCheckedAt: null,
  lastError: null,
  latest: {
    approvedById: null,
    commitSha: 'a'.repeat(40),
    contentHash: 'b'.repeat(64),
    createdAt: '2026-10-01T00:00:00Z',
    fileCount: 3,
    totalBytes: 100,
    version: 2,
    warnings: ['hooks are present'],
  },
  latestSha: null,
  latestVersion: 2,
  marketplaceEntry: null,
  marketplaceSourceId: null,
  name: 'review-kit',
  owner: 'acme',
  path: 'kit',
  ref: 'main',
  repo: 'pack',
  status: 'OK',
  trackStatus: 'OK',
  updatedAt: '2026-10-02T00:00:00Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  patch.mockResolvedValue({});
  state.rows = [profile({}), profile({ id: 'p2', name: 'old-kit', status: 'DISABLED' })];
  state.usage = new Map([['review-kit', { enabledTeams: 3, stranded: 2 }]]);
});

const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

describe('HarnessProfilesView', () => {
  it('lists the latest version, commit, file count, warnings and status', () => {
    render(<HarnessProfilesView />);
    const row = rowOf('review-kit');
    expect(row.textContent).toContain('v2');
    expect(row.textContent).toContain('aaaaaaa');
    expect(row.textContent).toContain('3 files · 1 warning(s)');
    expect(within(row).getByText('Enabled')).toBeTruthy();
    expect(within(rowOf('old-kit')).getByText('Disabled')).toBeTruthy();
  });

  it('opens details and the add flow', () => {
    render(<HarnessProfilesView />);
    fireEvent.click(within(rowOf('review-kit')).getByText('Details'));
    expect(screen.getByText('detail-modal:review-kit')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add from folder/ }));
    expect(screen.getByText('add-modal')).toBeTruthy();
  });

  it('confirms before disabling, and enables without a prompt', async () => {
    render(<HarnessProfilesView />);
    fireEvent.click(within(rowOf('review-kit')).getByRole('button', { name: /^More actions for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disable' }));
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Disable plugin' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({ name: 'review-kit', status: 'DISABLED' })
    );
    fireEvent.click(within(rowOf('old-kit')).getByRole('button', { name: /^More actions for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ name: 'old-kit', status: 'OK' }));
  });

  it('shows hooks, tracking, source, enabled teams and stranded agents', () => {
    state.rows = [
      profile({
        hooksEnabled: true,
        lastCheckedAt: '2026-10-03T00:00:00Z',
        marketplaceEntry: 'market-entry',
        marketplaceSourceId: 'm1',
        trackStatus: 'UPDATE_AVAILABLE',
      }),
      profile({ id: 'p2', name: 'old-kit' }),
    ];
    render(<HarnessProfilesView />);
    const row = rowOf('review-kit');
    expect(within(row).getByText('Hooks on')).toBeTruthy();
    expect(within(row).getByText('Update available')).toBeTruthy();
    expect(within(row).getByText('Marketplace')).toBeTruthy();
    expect(within(row).getByText('3')).toBeTruthy();
    expect(within(row).getByText('2 stranded')).toBeTruthy();
    const other = rowOf('old-kit');
    expect(within(other).getByText('Hooks off')).toBeTruthy();
    expect(within(other).getByText('Folder')).toBeTruthy();
    expect(within(other).getByText('Never checked')).toBeTruthy();
  });

  it('checks a plugin now from the row menu', async () => {
    check.mockResolvedValue({ check: { error: null, status: 'OK' }, recorded: true });
    render(<HarnessProfilesView />);
    fireEvent.click(within(rowOf('review-kit')).getByRole('button', { name: /^More actions for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Check now' }));
    await waitFor(() => expect(check).toHaveBeenCalledWith('review-kit'));
  });
});
