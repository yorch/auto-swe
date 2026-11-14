// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessProfileDetail, HarnessProfilePreview } from '@/hooks/useHarnessProfiles';

const SHA = 'c'.repeat(40);
const CONTENT = 'd'.repeat(64);
const WARNED = 'e'.repeat(64);

const { accept, checkFn, readFn, state } = vi.hoisted(() => ({
  accept: vi.fn(),
  checkFn: vi.fn(),
  readFn: vi.fn(),
  state: { detail: null as unknown },
}));
vi.mock('@/hooks/useHarnessProfiles', () => ({
  useAcceptProfileVersion: () => ({ isPending: false, mutateAsync: accept }),
  useHarnessProfile: () => ({ data: state.detail, error: null, isError: false, isLoading: false }),
  usePreviewProfileUpdate: () => ({ isPending: false, mutateAsync: checkFn }),
  useReviewUpdateFile: () => ({ isPending: false, mutateAsync: readFn }),
}));

const { ProfileDetailModal } = await import('./ProfileDetailModal');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const detail = (over: Partial<HarnessProfileDetail> = {}): HarnessProfileDetail => ({
  createdAt: '2026-10-01T00:00:00Z',
  description: 'Review kit',
  host: 'github.com',
  id: 'p1',
  latest: null,
  latestVersion: 1,
  name: 'review-kit',
  owner: 'acme',
  path: 'kit',
  ref: 'main',
  repo: 'pack',
  status: 'OK',
  updatedAt: '2026-10-01T00:00:00Z',
  versions: [
    {
      approvedById: 'u1',
      commitSha: 'a'.repeat(40),
      contentHash: 'b'.repeat(64),
      createdAt: '2026-10-01T00:00:00Z',
      fileCount: 1,
      files: [{ mode: '100644', path: 'profile.json', size: 80 }],
      manifest: { description: 'Review kit', name: 'review-kit' },
      totalBytes: 80,
      version: 1,
      warnings: ['hooks are present'],
    },
  ],
  ...over,
});

const preview = (over: Partial<HarnessProfilePreview> = {}): HarnessProfilePreview => ({
  conflicts: [],
  contentHash: CONTENT,
  files: [{ mode: '100644', path: 'profile.json', size: 90 }],
  manifest: { description: 'Review kit', name: 'review-kit' },
  matchesVersion: null,
  sha: SHA,
  source: { host: 'github.com', owner: 'acme', path: 'kit', ref: 'main', repo: 'pack' },
  totalBytes: 90,
  warnings: [],
  warningsHash: WARNED,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.detail = detail();
  accept.mockResolvedValue({ version: 2 });
});

describe('ProfileDetailModal', () => {
  it('lists versions with their files and acknowledged warnings', () => {
    render(<ProfileDetailModal name="review-kit" onClose={() => {}} />);
    expect(screen.getByText('v1')).toBeTruthy();
    expect(screen.getByText('1 acknowledged')).toBeTruthy();
    expect(screen.getByText(/profile\.json · 80 B/)).toBeTruthy();
  });

  it('checks for an update and accepts the previewed commit as the next version', async () => {
    checkFn.mockResolvedValue(preview());
    render(<ProfileDetailModal name="review-kit" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for update' }));
    expect(checkFn).toHaveBeenCalledWith({ name: 'review-kit' });
    fireEvent.click(await screen.findByRole('button', { name: 'Accept as version 2' }));
    await waitFor(() =>
      expect(accept).toHaveBeenCalledWith({
        acknowledgeWarnings: false,
        contentHash: CONTENT,
        name: 'review-kit',
        sha: SHA,
        warningsHash: WARNED,
      })
    );
    expect(await screen.findByText(/Version 2 was added/)).toBeTruthy();
  });

  it('has nothing to accept when the content already is a version', async () => {
    checkFn.mockResolvedValue(preview({ matchesVersion: 1 }));
    render(<ProfileDetailModal name="review-kit" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for update' }));
    expect(await screen.findByText(/already is version 1/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Accept as version 2' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('needs warnings acknowledged, and a disabled profile cannot accept', async () => {
    checkFn.mockResolvedValue(preview({ warnings: ['scripts are present'] }));
    render(<ProfileDetailModal name="review-kit" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for update' }));
    const accepting = (await screen.findByRole('button', {
      name: 'Accept as version 2',
    })) as HTMLButtonElement;
    expect(accepting.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(accepting.disabled).toBe(false);
  });

  it('disables accepting for a disabled profile', async () => {
    state.detail = detail({ status: 'DISABLED' });
    checkFn.mockResolvedValue(preview());
    render(<ProfileDetailModal name="review-kit" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for update' }));
    expect(await screen.findByText(/disabled; re-enable it/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Accept as version 2' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
