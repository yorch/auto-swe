// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceSourceDto } from '@/hooks/useMarketplaces';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { check, patch, remove, state } = vi.hoisted(() => ({
  check: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  state: { rows: [] as unknown[] },
}));
vi.mock('@/hooks/useMarketplaces', () => ({
  useCheckMarketplace: () => ({ isPending: false, mutateAsync: check }),
  useDeleteMarketplace: () => ({ isPending: false, mutateAsync: remove }),
  useMarketplaces: () => ({ data: state.rows, error: null, isError: false, isLoading: false }),
  usePatchMarketplace: () => ({ isPending: false, mutateAsync: patch }),
}));
vi.mock('./AddMarketplaceModal', () => ({
  AddMarketplaceModal: ({ open }: { open: boolean }) => (open ? <div>add-modal</div> : null),
}));
vi.mock('./MarketplaceDetailModal', () => ({
  MarketplaceDetailModal: ({ id }: { id: string | null }) => (id ? <div>detail:{id}</div> : null),
}));
vi.mock('./ReviewMarketplaceUpdateModal', () => ({
  ReviewMarketplaceUpdateModal: ({ source }: { source: { id: string } | null }) =>
    source ? <div>review:{source.id}</div> : null,
}));

const { MarketplacesTab } = await import('./MarketplacesTab');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const source = (over: Partial<MarketplaceSourceDto>): MarketplaceSourceDto => ({
  createdAt: '2026-10-01T00:00:00Z',
  createdById: 'u1',
  host: 'github.com',
  id: 'm1',
  lastCheckedAt: '2026-10-02T00:00:00Z',
  lastError: null,
  latestSha: 'b'.repeat(40),
  owner: 'acme',
  path: '',
  pinnedSha: 'a'.repeat(40),
  profileCount: 2,
  ref: 'main',
  repo: 'market',
  status: 'OK',
  updatedAt: '2026-10-02T00:00:00Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue({ check: { error: null, status: 'OK' }, recorded: true });
  patch.mockResolvedValue({});
  remove.mockResolvedValue(undefined);
  state.rows = [
    source({ status: 'UPDATE_AVAILABLE' }),
    source({ id: 'm2', repo: 'other', status: 'DISABLED' }),
  ];
});

const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

describe('MarketplacesTab', () => {
  it('lists status, short pinned and latest sha, last check and plugin count', () => {
    render(<MarketplacesTab />);
    const row = rowOf('github.com/acme/market');
    expect(row.textContent).toContain('aaaaaaa / bbbbbbb');
    expect(within(row).getByText('Update available')).toBeTruthy();
    expect(within(row).getByText('2')).toBeTruthy();
    expect(within(rowOf('github.com/acme/other')).getByText('Disabled')).toBeTruthy();
  });

  it('opens review, catalog and add', () => {
    render(<MarketplacesTab />);
    fireEvent.click(within(rowOf('github.com/acme/market')).getByText('Review update'));
    expect(screen.getByText('review:m1')).toBeTruthy();
    fireEvent.click(within(rowOf('github.com/acme/market')).getByText('Catalog'));
    expect(screen.getByText('detail:m1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add marketplace/ }));
    expect(screen.getByText('add-modal')).toBeTruthy();
  });

  it('checks now, and a disabled marketplace cannot be checked', async () => {
    render(<MarketplacesTab />);
    fireEvent.click(within(rowOf('github.com/acme/market')).getByText('Check now'));
    await waitFor(() => expect(check).toHaveBeenCalledWith('m1'));
    expect(
      (within(rowOf('github.com/acme/other')).getByText('Check now') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('disables and enables from the menu, and confirms before deleting', async () => {
    render(<MarketplacesTab />);
    fireEvent.click(
      within(rowOf('github.com/acme/market')).getByRole('button', { name: /^More actions for/ })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disable' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ id: 'm1', status: 'DISABLED' }));
    fireEvent.click(
      within(rowOf('github.com/acme/other')).getByRole('button', { name: /^More actions for/ })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ id: 'm2', status: 'OK' }));
    fireEvent.click(
      within(rowOf('github.com/acme/market')).getByRole('button', { name: /^More actions for/ })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete marketplace' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('m1'));
  });
});
