// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffAddedSkill } from '@/hooks/useSkillSources';
import { ApiError } from '@/lib/api';

const PINNED = 'a'.repeat(40);
const LATEST = 'b'.repeat(40);

const { install, readFull, refetch, refetchSources, state, useDiff } = vi.hoisted(() => ({
  install: vi.fn(),
  readFull: vi.fn(),
  refetch: vi.fn(),
  refetchSources: vi.fn(),
  state: { diff: undefined as unknown, pinned: 'a'.repeat(40) },
  useDiff: vi.fn(),
}));
vi.mock('@/hooks/useSkillSources', () => ({
  useInstallIntoSource: () => ({ isPending: false, mutateAsync: install }),
  useReadIncomingSkill: () => ({ isPending: false, mutateAsync: readFull }),
  useSkillSources: () => ({
    data: [
      {
        host: 'github.com',
        id: 'src-1',
        latestSha: 'b'.repeat(40),
        owner: 'acme',
        path: 'skills',
        pinnedSha: state.pinned,
        repo: 'pack',
        status: 'UPDATE_AVAILABLE',
      },
    ],
    isLoading: false,
    refetch: refetchSources,
  }),
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

const incoming = (name: string, sha = PINNED, promptText = `FULL ${name}`) => ({
  description: null,
  errors: [],
  folder: `skills/${name}`,
  name,
  promptText,
  referenceFiles: [],
  sha,
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
const readFirst = async (name: string) => {
  fireEvent.click(screen.getByLabelText(`Read full text of ${name}`));
  await screen.findByLabelText(`Full text of ${name}`);
};
const show = () => render(<InstallSkillsModal onClose={() => {}} sourceId="src-1" />);

beforeEach(() => {
  vi.clearAllMocks();
  state.pinned = PINNED;
  refetchSources.mockResolvedValue(undefined);
  readFull.mockImplementation(async ({ name, sha }: { name: string; sha: string }) =>
    incoming(name, sha)
  );
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
    fireEvent.click(screen.getByLabelText('Read full text of fresh'));
    await screen.findByLabelText('Full text of fresh');
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
    // Even a clean candidate waits for its full text to be read.
    expect(btn('fine').disabled).toBe(true);
    expect(screen.getByLabelText('Read full text of fine')).toBeTruthy();
    expect(screen.queryByLabelText('Read full text of warned')).toBeNull();
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
      await readFirst('fresh');
      fireEvent.click(screen.getByLabelText('Install fresh'));
      expect(await screen.findByText(/The source changed since this was read/)).toBeTruthy();
      fireEvent.click(screen.getByText('Reload'));
      await waitFor(() => expect(refetchSources).toHaveBeenCalled());
      await waitFor(() => expect(refetch).toHaveBeenCalled());
    }
  );

  it('shows other refusals with their reasons and no reload', async () => {
    install.mockRejectedValueOnce(
      new ApiError('Some chosen skills drew scanner warnings', 422, 'SKILL_IMPORT_SCAN_WARNINGS', [
        { name: 'fresh', warnings: ['exfil:curl'] },
      ])
    );
    show();
    await readFirst('fresh');
    fireEvent.click(screen.getByLabelText('Install fresh'));
    expect(await screen.findByText(/drew scanner warnings.*exfil:curl/)).toBeTruthy();
    expect(screen.queryByText('Reload')).toBeNull();
  });

  it('Install is off until the full text has been read, and the text is shown with hidden characters visible', async () => {
    readFull.mockResolvedValueOnce(incoming('fresh', PINNED, 'line one\nhidden \u202e part'));
    show();
    const install_ = screen.getByLabelText('Install fresh') as HTMLButtonElement;
    expect(install_.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Read full text of fresh'));
    const panel = await screen.findByLabelText('Full text of fresh');
    expect(panel.textContent).toBe('line one\nhidden ⟨U+202E⟩ part');
    expect(panel.className).toContain('overflow-auto');
    expect(readFull).toHaveBeenCalledWith({ id: 'src-1', name: 'fresh', sha: PINNED });
    expect(install_.disabled).toBe(false);
    expect(screen.getByText(/Each read costs one full fetch/)).toBeTruthy();
  });

  it('offers no read, and no install, for a candidate that would be refused', () => {
    setDiff([added('broken', { errors: ['bad'] })]);
    show();
    expect(screen.queryByLabelText('Read full text of broken')).toBeNull();
  });

  it('a text read at another commit does not unlock Install', async () => {
    readFull.mockResolvedValueOnce(incoming('fresh', LATEST));
    show();
    fireEvent.click(screen.getByLabelText('Read full text of fresh'));
    expect(await screen.findByText(/read at a different commit/)).toBeTruthy();
    expect((screen.getByLabelText('Install fresh') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Full text of fresh')).toBeNull();
  });

  it('Reload discards the texts read: Install is off again until it is read again', async () => {
    install.mockRejectedValueOnce(new ApiError('It changed.', 409, 'SKILL_IMPORT_SOURCE_CHANGED'));
    show();
    await readFirst('fresh');
    fireEvent.click(screen.getByLabelText('Install fresh'));
    fireEvent.click(await screen.findByText('Reload'));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(screen.queryByLabelText('Full text of fresh')).toBeNull();
    expect((screen.getByLabelText('Install fresh') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a stale pin: Reload re-reads the source, and the list then follows the current pin', async () => {
    const NEW_PIN = 'd'.repeat(40);
    install.mockRejectedValueOnce(
      new ApiError('moved', 409, 'SKILL_IMPORT_STALE_SHA', { pinnedSha: NEW_PIN })
    );
    const view = show();
    await readFirst('fresh');
    fireEvent.click(screen.getByLabelText('Install fresh'));
    fireEvent.click(await screen.findByText('Reload'));
    await waitFor(() => expect(refetchSources).toHaveBeenCalled());
    // The refreshed source list now carries the new pin.
    state.pinned = NEW_PIN;
    setDiff([added('fresh')], NEW_PIN);
    view.rerender(<InstallSkillsModal onClose={() => {}} sourceId="src-1" />);
    expect(useDiff).toHaveBeenLastCalledWith('src-1', NEW_PIN);
    await readFirst('fresh');
    fireEvent.click(screen.getByLabelText('Install fresh'));
    await waitFor(() =>
      expect(install).toHaveBeenLastCalledWith({ id: 'src-1', sha: NEW_PIN, skills: ['fresh'] })
    );
  });
});
