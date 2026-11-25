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
  state: { detail: null as unknown, enablements: [] as unknown[] },
}));
vi.mock('@/hooks/useMcpConnections', () => ({
  useMcpConnections: () => ({ data: [], isError: false }),
}));
vi.mock('@/hooks/useHarnessProfiles', () => ({
  useAcceptProfileVersion: () => ({ isPending: false, mutateAsync: accept }),
  useCheckProfile: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useHarnessProfile: () => ({ data: state.detail, error: null, isError: false, isLoading: false }),
  usePatchProfile: () => ({ isPending: false, mutateAsync: vi.fn() }),
  usePreviewProfileUpdate: () => ({ isPending: false, mutateAsync: checkFn }),
  useProfileEnablements: () => ({ data: state.enablements }),
  useRemoveMcpMapping: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useReviewUpdateFile: () => ({ isPending: false, mutateAsync: readFn }),
  useSetMcpMapping: () => ({ isPending: false, mutateAsync: vi.fn() }),
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
  hooksEnabled: false,
  host: 'github.com',
  id: 'p1',
  lastCheckedAt: null,
  lastError: null,
  latest: null,
  latestSha: null,
  latestVersion: 1,
  marketplaceEntry: null,
  marketplaceSourceId: null,
  name: 'review-kit',
  owner: 'acme',
  path: 'kit',
  ref: 'main',
  repo: 'pack',
  status: 'OK',
  trackStatus: 'OK',
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
  state.enablements = [];
  accept.mockResolvedValue({ data: { version: 2 }, projection: null });
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

  it('requires reviewing hook changes on a hooks-on plugin, and sends the acknowledgement', async () => {
    state.detail = detail({ hooksEnabled: true });
    checkFn.mockResolvedValue(
      preview({
        hookChanges: {
          added: [],
          changed: [
            { addedCommands: ['curl evil‮'], path: 'hooks/hooks.json', removedCommands: ['lint'] },
          ],
          removed: [],
        },
        hooksEnabled: true,
      })
    );
    render(<ProfileDetailModal name="review-kit" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for update' }));
    const accepting = (await screen.findByRole('button', {
      name: 'Accept as version 2',
    })) as HTMLButtonElement;
    expect(screen.getByText('curl evil⟨U+202E⟩')).toBeTruthy();
    expect(accepting.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have reviewed the hook changes' }));
    expect(accepting.disabled).toBe(false);
    fireEvent.click(accepting);
    await waitFor(() =>
      expect(accept).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeHookChanges: true, name: 'review-kit' })
      )
    );
  });

  it('asks no hook acknowledgement when hooks are off', async () => {
    state.detail = detail({ hooksEnabled: false });
    checkFn.mockResolvedValue(
      preview({
        hookChanges: {
          added: [{ commands: ['run'], path: 'hooks/hooks.json' }],
          changed: [],
          removed: [],
        },
        hooksEnabled: false,
      })
    );
    render(<ProfileDetailModal name="review-kit" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for update' }));
    const accepting = (await screen.findByRole('button', {
      name: 'Accept as version 2',
    })) as HTMLButtonElement;
    expect(screen.queryByRole('checkbox', { name: /reviewed the hook changes/ })).toBeNull();
    expect(accepting.disabled).toBe(false);
  });

  it('shows the hook switch, bound agents with the stranded flagged, and enabled teams', () => {
    state.detail = detail({
      boundAgents: [
        { key: 'reviewer', scope: 'GLOBAL', stranded: false, teamId: null, version: 3 },
        { key: 'fixer', scope: 'TEAM', stranded: true, teamId: 't1', version: 1 },
      ],
      enabledTeams: 1,
      hooksEnabled: true,
    });
    state.enablements = [
      {
        enabledAt: '2026-10-02T00:00:00Z',
        enabledById: 'u1',
        teamId: 't2',
        teamName: 'Payments',
        teamSlug: 'payments',
      },
    ];
    render(<ProfileDetailModal name="review-kit" onClose={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Hooks for review-kit' })).toBeTruthy();
    expect(screen.getByText('Stranded')).toBeTruthy();
    expect(screen.getByText('fixer')).toBeTruthy();
    expect(screen.getByText(/Payments/)).toBeTruthy();
  });
});
