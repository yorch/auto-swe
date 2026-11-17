// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceSourceDto } from '@/hooks/useMarketplaces';

const { accept, previewFn } = vi.hoisted(() => ({ accept: vi.fn(), previewFn: vi.fn() }));
vi.mock('@/hooks/useMarketplaces', () => ({
  useAcceptMarketplaceUpdate: () => ({ isPending: false, mutateAsync: accept }),
  usePreviewMarketplace: () => ({ isPending: false, mutateAsync: previewFn }),
}));

const { ReviewMarketplaceUpdateModal } = await import('./ReviewMarketplaceUpdateModal');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const LATEST = 'b'.repeat(40);
const source: MarketplaceSourceDto = {
  createdAt: '2026-10-01T00:00:00Z',
  createdById: 'u1',
  host: 'github.com',
  id: 'm1',
  lastCheckedAt: null,
  lastError: null,
  latestSha: LATEST,
  owner: 'acme',
  path: '',
  pinnedSha: 'a'.repeat(40),
  profileCount: 0,
  ref: 'main',
  repo: 'market',
  status: 'UPDATE_AVAILABLE',
  updatedAt: '2026-10-02T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  accept.mockResolvedValue({});
  previewFn.mockResolvedValue({
    catalog: { entries: [], ignoredKeys: [], name: 'acme-market', ownerName: null },
    existingId: 'm1',
    sha: LATEST,
    source: { host: 'github.com', owner: 'acme', path: '', ref: 'main', repo: 'market' },
  });
});

describe('ReviewMarketplaceUpdateModal', () => {
  it('reads the catalog at the newer commit and accepts exactly that sha', async () => {
    const onClose = vi.fn();
    render(<ReviewMarketplaceUpdateModal onClose={onClose} source={source} />);
    await screen.findByText(/lists no plugins/);
    expect(previewFn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'market', sha: LATEST })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept update' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith({ id: 'm1', sha: LATEST }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
