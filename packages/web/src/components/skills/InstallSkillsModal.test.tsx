// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffAddedSkill, SkillSource } from '@/hooks/useSkillSources';
import { ApiError } from '@/lib/api';

const PINNED = 'a'.repeat(40);
const LATEST = 'b'.repeat(40);

const { install, refetch, state, useDiff } = vi.hoisted(() => ({
  install: vi.fn(),
  refetch: vi.fn(),
  state: { diff: undefined as unknown },
  useDiff: vi.fn(),
}));
vi.mock('@/hooks/useSkillSources', () => ({
  useInstallIntoSource: () => ({ isPending: false, mutateAsync: install }),
  useSourceDiff: (...args: unknown[]) => {
    useDiff(...args);
    return { data: state.diff, error: null, isLoading: false, refetch };
  },
}));

const { InstallSkillsModal, notInstallableReason } = await import('./InstallSkillsModal');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const source = {
  host: 'github.com',
  id: 'src-1',
  latestSha: LATEST,
  owner: 'acme',
  path: 'skills',
  pinnedSha: PINNED,
  repo: 'pack',
  status: 'UPDATE_AVAILABLE',
} as unknown as SkillSource;

const added = (name: string, over: Partial<DiffAddedSkill> = {}): DiffAddedSkill => ({
  blockedByScan: false,
  conflicts: [],
  description: `${name} d`,
  errors: [],
  folder: `skills/${name}`,
  ignoredKeys: [],
  name,
  referenceFileCount: 0,
  scanWarnings: [],
  skippedFiles: [],
  textLength: 40,
  ...over,
});

const setDiff = (skills: DiffAddedSkill[], sha = PINNED) => {
  state.diff = {
    added: skills,
    changed: [],
    errors: [],
    removed: [],
    sha,
    source: { id: 'src-1', latestSha: LATEST, pinnedSha: PINNED, status: 'UPDATE_AVAILABLE' },
    unchanged: [],
  };
};
const show = () => render(<InstallSkillsModal onClose={() => {}} source={source} />);

beforeEach(() => {
  vi.clearAllMocks();
  install.mockResolvedValue({ skills: [] });
  setDiff([added('fresh')]);
});

describe('InstallSkillsModal', () => {
  it('reads the diff at the pinned commit, never at the latest', () => {
    show();
    expect(useDiff).toHaveBeenCalledWith('src-1', PINNED);
    expect(screen.getByText(/Read at the pinned commit aaaaaaa/)).toBeTruthy();
  });

  it('installs with the sha of the diff it displays (the pinned commit)', async () => {
    show();
    fireEvent.click(screen.getByLabelText('Install fresh'));
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith({ id: 'src-1', sha: PINNED, skills: ['fresh'] })
    );
    await waitFor(() => expect(screen.queryByLabelText('Install fresh')).toBeNull());
  });

  it('disables Install for errors, conflicts and blocking scan warnings, and says why', () => {
    setDiff([
      added('broken', { errors: ['bad'] }),
      added('taken', { conflicts: [{ id: 'k', name: 'taken', scope: 'TEAM' }] }),
      added('warned', { blockedByScan: true, scanWarnings: ['injection:x'] }),
      added('fine'),
    ]);
    show();
    const btn = (n: string) => screen.getByLabelText(`Install ${n}`) as HTMLButtonElement;
    expect(btn('broken').disabled).toBe(true);
    expect(btn('taken').disabled).toBe(true);
    expect(btn('warned').disabled).toBe(true);
    expect(btn('fine').disabled).toBe(false);
    expect(screen.getByText('name already used by a TEAM skill')).toBeTruthy();
    expect(screen.getByText('scan: injection:x')).toBeTruthy();
    expect(notInstallableReason(added('x', { blockedByScan: true }))).toMatch(
      /blockOnScanWarnings/
    );
  });

  it.each(['SKILL_IMPORT_STALE_SHA', 'SKILL_IMPORT_SOURCE_CHANGED', 'SKILL_IMPORT_DISABLED'])(
    '%s offers a reload',
    async (code) => {
      install.mockRejectedValueOnce(new ApiError('It changed.', 409, code));
      show();
      fireEvent.click(screen.getByLabelText('Install fresh'));
      expect(await screen.findByText(/The source changed since this was read/)).toBeTruthy();
      fireEvent.click(screen.getByText('Reload'));
      expect(refetch).toHaveBeenCalled();
    }
  );

  it('shows other refusals with their reasons and no reload', async () => {
    install.mockRejectedValueOnce(
      new ApiError('Some chosen skills drew scanner warnings', 422, 'SKILL_IMPORT_SCAN_WARNINGS', [
        { name: 'fresh', warnings: ['exfil:curl'] },
      ])
    );
    show();
    fireEvent.click(screen.getByLabelText('Install fresh'));
    expect(await screen.findByText(/drew scanner warnings.*exfil:curl/)).toBeTruthy();
    expect(screen.queryByText('Reload')).toBeNull();
  });
});
