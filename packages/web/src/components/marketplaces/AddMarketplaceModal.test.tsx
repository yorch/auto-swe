// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplacePreview } from '@/hooks/useMarketplaces';
import { ApiError } from '@/lib/api';

const SHA = 'c'.repeat(40);
const { add, previewFn } = vi.hoisted(() => ({ add: vi.fn(), previewFn: vi.fn() }));
vi.mock('@/hooks/useMarketplaces', () => ({
  useAddMarketplace: () => ({ isPending: false, mutateAsync: add }),
  usePreviewMarketplace: () => ({ isPending: false, mutateAsync: previewFn }),
}));

const { AddMarketplaceModal } = await import('./AddMarketplaceModal');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const previewed = (over: Partial<MarketplacePreview> = {}): MarketplacePreview => ({
  catalog: {
    entries: [
      {
        description: 'd',
        ignoredKeys: [],
        installable: true,
        name: 'kit',
        nameTaken: false,
        profile: null,
        reason: null,
        source: { kind: 'relative', path: 'plugins/kit' },
        version: null,
      },
    ],
    ignoredKeys: [],
    name: 'acme-market',
    ownerName: 'Acme',
  },
  existingId: null,
  sha: SHA,
  source: { host: 'github.com', owner: 'acme', path: '', ref: 'main', repo: 'market' },
  ...over,
});

async function openAndPreview() {
  render(<AddMarketplaceModal onClose={() => {}} open />);
  fireEvent.change(screen.getByLabelText(/^Owner/), { target: { value: 'acme' } });
  fireEvent.change(screen.getByLabelText(/^Repository/), { target: { value: 'market' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText('Review marketplace');
}

beforeEach(() => {
  vi.clearAllMocks();
  add.mockResolvedValue({});
  previewFn.mockResolvedValue(previewed());
});

describe('AddMarketplaceModal', () => {
  it('previews the catalog, then adds it pinned to the previewed commit', async () => {
    await openAndPreview();
    expect(previewFn).toHaveBeenCalledWith({
      host: 'github.com',
      owner: 'acme',
      path: '',
      ref: 'main',
      repo: 'market',
    });
    expect(screen.getByText('acme-market')).toBeTruthy();
    expect(screen.getByText('kit')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add marketplace' }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        host: 'github.com',
        owner: 'acme',
        path: '',
        ref: 'main',
        repo: 'market',
        sha: SHA,
      })
    );
  });

  it('will not add one that already exists', async () => {
    previewFn.mockResolvedValue(previewed({ existingId: 'm9' }));
    await openAndPreview();
    expect(screen.getByText(/already added/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Add marketplace' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('offers a fresh preview when the marketplace moved', async () => {
    add.mockRejectedValue(new ApiError('The marketplace moved', 409, 'MARKETPLACE_SHA_MOVED'));
    await openAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Add marketplace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(previewFn).toHaveBeenCalledTimes(2));
  });

  it('lists the reasons for an invalid marketplace', async () => {
    previewFn.mockRejectedValue(
      new ApiError('Not a valid marketplace', 422, 'MARKETPLACE_INVALID', {
        errors: ['marketplace.json: name is required'],
      })
    );
    render(<AddMarketplaceModal onClose={() => {}} open />);
    fireEvent.change(screen.getByLabelText(/^Owner/), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText(/^Repository/), { target: { value: 'market' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('marketplace.json: name is required')).toBeTruthy();
  });
});
