// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryPreview } from '@/hooks/useMarketplaces';
import { ApiError } from '@/lib/api';

const SHA = 'c'.repeat(40);
const CONTENT = 'd'.repeat(64);
const WARNED = 'e'.repeat(64);

const { approve, previewFn } = vi.hoisted(() => ({ approve: vi.fn(), previewFn: vi.fn() }));
vi.mock('@/hooks/useMarketplaces', () => ({
  useApproveEntry: () => ({ isPending: false, mutateAsync: approve }),
  usePreviewEntry: () => ({ isPending: false, mutateAsync: previewFn }),
}));

const { EntryApproveModal } = await import('./EntryApproveModal');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const preview = (over: Partial<EntryPreview> = {}): EntryPreview => ({
  conflicts: [],
  contentHash: CONTENT,
  entry: { description: 'd', name: 'kit', source: null, version: '1.0.0' },
  files: [{ mode: '100644', path: '.claude-plugin/plugin.json', size: 40 }],
  hasHooks: true,
  manifest: { description: 'Kit', name: 'kit' },
  matchesVersion: null,
  mcpServers: [
    { name: 'docs', supported: true, transport: 'http', url: 'https://mcp.example.com' },
    { name: 'local', supported: false, transport: 'stdio', url: null },
  ],
  sha: SHA,
  source: { host: 'github.com', owner: 'acme', path: 'plugins/kit', ref: 'main', repo: 'market' },
  totalBytes: 40,
  warnings: [],
  warningsHash: WARNED,
  ...over,
});

const renderModal = () =>
  render(<EntryApproveModal entry="kit" marketplaceId="m1" onClose={() => {}} />);

beforeEach(() => {
  vi.clearAllMocks();
  previewFn.mockResolvedValue(preview());
  approve.mockResolvedValue({
    commitSha: SHA,
    hooksEnabled: false,
    id: 'p1',
    name: 'kit',
    projection: null,
    version: 1,
  });
});

describe('EntryApproveModal', () => {
  it('previews the entry and lists files, MCP servers and the hooks flag', async () => {
    renderModal();
    expect(await screen.findByText('.claude-plugin/plugin.json')).toBeTruthy();
    expect(previewFn).toHaveBeenCalledWith({ entry: 'kit', id: 'm1' });
    expect(screen.getByText('Supported')).toBeTruthy();
    expect(screen.getByText('Unsupported')).toBeTruthy();
    expect(screen.getByText('The plugin declares hooks')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Read / })).toBeNull();
  });

  it('approves with the previewed sha and both hashes, and an explicit hook choice', async () => {
    renderModal();
    const off = (await screen.findByRole('radio', { name: /Hooks off/ })) as HTMLInputElement;
    expect(off.checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Hooks on/ }));
    expect(
      (screen.getByRole('button', { name: 'Approve plugin' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have reviewed these hook sources' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve plugin' }));
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith({
        acknowledgeWarnings: false,
        contentHash: CONTENT,
        entry: 'kit',
        hooksEnabled: true,
        id: 'm1',
        sha: SHA,
        warningsHash: WARNED,
      })
    );
    expect(await screen.findByText('Plugin approved')).toBeTruthy();
  });

  it('will not approve warnings until they are acknowledged', async () => {
    previewFn.mockResolvedValue(preview({ warnings: ['scripts are present'] }));
    renderModal();
    const button = (await screen.findByRole('button', {
      name: 'Approve plugin',
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(expect.objectContaining({ acknowledgeWarnings: true }))
    );
  });

  it('refuses a taken name', async () => {
    previewFn.mockResolvedValue(preview({ conflicts: [{ name: 'Kit', status: 'OK' }] }));
    renderModal();
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Approve plugin' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('offers a fresh preview when the commit moved or the preview is stale', async () => {
    approve.mockRejectedValue(new ApiError('The content differs', 409, 'PREVIEW_STALE'));
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve plugin' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(previewFn).toHaveBeenCalledTimes(2));
  });

  it('shows a refused entry read', async () => {
    previewFn.mockRejectedValue(
      new ApiError('The entry cannot be installed', 422, 'MARKETPLACE_ENTRY_NOT_INSTALLABLE')
    );
    renderModal();
    expect(await screen.findByText('The entry cannot be installed')).toBeTruthy();
  });
});
