// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffAddedSkill, DiffChangedSkill, SourceDiff } from '@/hooks/useSkillSources';
import { ApiError } from '@/lib/api';

const PINNED = 'a'.repeat(40);
const LATEST = 'b'.repeat(40);

const { accept, install, readFull, refetch, state } = vi.hoisted(() => ({
  accept: vi.fn(),
  install: vi.fn(),
  readFull: vi.fn(),
  refetch: vi.fn(),
  state: { diff: undefined as unknown, error: null as unknown, loading: false },
}));
vi.mock('@/hooks/useSkillSources', () => ({
  useAcceptUpdate: () => ({ isPending: false, mutateAsync: accept }),
  useInstallIntoSource: () => ({ isPending: false, mutateAsync: install }),
  useReadIncomingSkill: () => ({ isPending: false, mutateAsync: readFull }),
  useSourceDiff: () => ({
    data: state.diff,
    error: state.error,
    isLoading: state.loading,
    refetch,
  }),
}));

const { ReviewUpdateModal } = await import('./ReviewUpdateModal');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const changed = (name: string, over: Partial<DiffChangedSkill> = {}): DiffChangedSkill => ({
  blockedByScan: false,
  description: { changed: false, new: `${name} d`, old: `${name} d` },
  diffIncomplete: false,
  diffTooLarge: false,
  folder: `skills/${name}`,
  handEdited: false,
  ignoredKeys: [],
  installedRevision: 3,
  name,
  referenceFiles: { added: [], changed: [], removed: [] },
  renamedTo: null,
  scanWarnings: [],
  skillId: `id-${name}`,
  skippedFiles: [],
  textDiff: '@@ -1,1 +1,1 @@\n-old\n+new',
  textDiffTruncated: false,
  textLength: { new: 10, old: 8 },
  ...over,
});

const added = (name: string, over: Partial<DiffAddedSkill> = {}): DiffAddedSkill => ({
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

const diff = (over: Partial<SourceDiff> = {}): SourceDiff => ({
  added: [],
  changed: [],
  errors: [],
  removed: [],
  sha: LATEST,
  source: { id: 'src-1', latestSha: LATEST, pinnedSha: PINNED, status: 'UPDATE_AVAILABLE' },
  unchanged: [],
  ...over,
});

const show = () => render(<ReviewUpdateModal onClose={() => {}} sourceId="src-1" />);
const accepted = (over = {}) => ({
  accepted: [{ fromRevision: 3, id: 'id-a', name: 'a', revision: 4 }],
  after: { pinnedSha: LATEST, status: 'OK' },
  conflicts: [],
  notSelected: [],
  pinAdvanced: true,
  removed: [],
  sha: LATEST,
  unreadable: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.diff = diff();
  state.error = null;
  state.loading = false;
  accept.mockResolvedValue(accepted());
  install.mockResolvedValue({ skills: [] });
});

describe('diff rendering', () => {
  it('summarises the commits and counts', () => {
    state.diff = diff({
      added: [added('n')],
      changed: [changed('a')],
      removed: [{ folder: 'skills/gone', name: 'gone', skillId: 'id-gone' }],
      unchanged: [{ handEdited: false, name: 'u', renamedTo: null, skillId: 'id-u' }],
    });
    show();
    expect(
      screen.getByText(/Pinned aaaaaaa → bbbbbbb: 1 changed, 1 unchanged, 1 not installed/)
    ).toBeTruthy();
    expect(screen.getByText(/gone \(skills\/gone\)/)).toBeTruthy();
  });

  it('colours additions and removals and shows old and new description, rename and file changes', () => {
    state.diff = diff({
      changed: [
        changed('a', {
          description: { changed: true, new: 'fresh', old: 'stale' },
          referenceFiles: { added: ['n.md'], changed: [], removed: ['o.md'] },
          renamedTo: 'a-two',
          scanWarnings: ['injection:x'],
        }),
      ],
    });
    show();
    expect(screen.getByText('+new').className).toContain('text-moss-400');
    expect(screen.getByText('-old').className).toContain('text-brick-400');
    expect(screen.getByText('stale')).toBeTruthy();
    expect(screen.getByText('fresh')).toBeTruthy();
    expect(screen.getByText(/Upstream now names it a-two/)).toBeTruthy();
    expect(screen.getByText('reference files added: n.md')).toBeTruthy();
    expect(screen.getByText('reference files removed: o.md')).toBeTruthy();
    expect(screen.getByText('scan: injection:x')).toBeTruthy();
  });

  it('shows hidden characters in names, descriptions and diff lines', () => {
    state.diff = diff({
      changed: [
        changed('ev‮il', {
          description: { changed: true, new: 'n​ew', old: null },
          textDiff: '+a⁦b',
        }),
      ],
    });
    show();
    expect(screen.getByText('Update ev⟨U+202E⟩il')).toBeTruthy();
    expect(screen.getByText('n⟨U+200B⟩ew')).toBeTruthy();
    expect(screen.getByText('+a⟨U+2066⟩b')).toBeTruthy();
  });

  it('says so when a diff is too large to show', () => {
    state.diff = diff({
      changed: [changed('a', { diffIncomplete: true, diffTooLarge: true, textDiff: '' })],
    });
    show();
    expect(screen.getByText('The diff is too large to show.')).toBeTruthy();
    expect(screen.getByText('diff too large')).toBeTruthy();
  });

  it('lists the installed skills that can no longer be updated', () => {
    state.diff = diff({
      errors: [{ errors: ['bad frontmatter'], folder: 'skills/x', name: 'x', skillId: 'id-x' }],
    });
    show();
    expect(screen.getByText('x: bad frontmatter')).toBeTruthy();
  });

  it('shows the load failure', () => {
    state.diff = undefined;
    state.error = new Error('No newer commit has been recorded yet');
    show();
    expect(screen.getByText(/No newer commit has been recorded yet/)).toBeTruthy();
  });
});

describe('accepting', () => {
  it('sends the diffed sha with each selected skill bound to the revision the diff showed', async () => {
    state.diff = diff({
      changed: [changed('a', { installedRevision: 7 }), changed('b', { installedRevision: 2 })],
    });
    show();
    fireEvent.click(screen.getByText('Accept 2 skills'));
    await waitFor(() =>
      expect(accept).toHaveBeenCalledWith({
        id: 'src-1',
        sha: LATEST,
        skills: [
          { name: 'a', revision: 7 },
          { name: 'b', revision: 2 },
        ],
      })
    );
  });

  it('sends only the skills left selected', async () => {
    state.diff = diff({ changed: [changed('a'), changed('b', { installedRevision: 9 })] });
    show();
    fireEvent.click(screen.getByLabelText('Update a'));
    fireEvent.click(screen.getByText('Accept 1 skill'));
    await waitFor(() =>
      expect(accept).toHaveBeenCalledWith({
        id: 'src-1',
        sha: LATEST,
        skills: [{ name: 'b', revision: 9 }],
      })
    );
  });

  it('starts hand-edited and incomplete skills unselected and cannot select them unconfirmed', () => {
    state.diff = diff({
      changed: [
        changed('clean'),
        changed('mine', { handEdited: true }),
        changed('big', { diffIncomplete: true }),
      ],
    });
    show();
    const box = (n: string) => screen.getByLabelText(`Update ${n}`) as HTMLInputElement;
    expect(box('clean').checked).toBe(true);
    expect(box('mine').checked).toBe(false);
    expect(box('mine').disabled).toBe(true);
    expect(box('big').checked).toBe(false);
    expect(box('big').disabled).toBe(true);
    expect(screen.getByText('edited by hand')).toBeTruthy();
    expect(screen.getByText('diff incomplete')).toBeTruthy();
    expect(screen.getByText('Accept 1 skill')).toBeTruthy();
  });

  it('a hand-edited skill needs the explicit overwrite confirmation, then is sent', async () => {
    state.diff = diff({ changed: [changed('mine', { handEdited: true, installedRevision: 5 })] });
    show();
    fireEvent.click(screen.getByLabelText(/Overwrite my edit/));
    const pick = screen.getByLabelText('Update mine') as HTMLInputElement;
    expect(pick.disabled).toBe(false);
    fireEvent.click(pick);
    fireEvent.click(screen.getByText('Accept 1 skill'));
    await waitFor(() =>
      expect(accept).toHaveBeenCalledWith({
        id: 'src-1',
        sha: LATEST,
        skills: [{ name: 'mine', revision: 5 }],
      })
    );
  });

  it('withdrawing the confirmation unselects the skill again', () => {
    state.diff = diff({ changed: [changed('mine', { handEdited: true })] });
    show();
    fireEvent.click(screen.getByLabelText(/Overwrite my edit/));
    fireEvent.click(screen.getByLabelText('Update mine'));
    expect(screen.getByText('Accept 1 skill')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Overwrite my edit/));
    expect(screen.getByText('Accept 0 skills')).toBeTruthy();
  });

  it('an incomplete skill: the full text is read from the server, shown scrollable and visibly, and confirmed before it can be sent', async () => {
    readFull.mockResolvedValue({
      description: null,
      errors: [],
      folder: 'skills/big',
      name: 'big',
      promptText: 'line one\nhidden ‮ part',
      referenceFiles: [],
      sha: LATEST,
    });
    state.diff = diff({
      changed: [changed('big', { diffIncomplete: true, installedRevision: 4 })],
    });
    show();
    const read = screen.getByLabelText("I've read the full text") as HTMLInputElement;
    expect(read.disabled).toBe(true);
    fireEvent.click(screen.getByText('Read full incoming text'));
    await waitFor(() =>
      expect(readFull).toHaveBeenCalledWith({ id: 'src-1', name: 'big', sha: LATEST })
    );
    const panel = await screen.findByLabelText('Full incoming text of big');
    expect(panel.className).toContain('overflow-auto');
    expect(panel.textContent).toBe('line one\nhidden ⟨U+202E⟩ part');
    expect(read.disabled).toBe(false);
    fireEvent.click(read);
    fireEvent.click(screen.getByLabelText('Update big'));
    fireEvent.click(screen.getByText('Accept 1 skill'));
    await waitFor(() =>
      expect(accept).toHaveBeenCalledWith({
        id: 'src-1',
        sha: LATEST,
        skills: [{ name: 'big', revision: 4 }],
      })
    );
  });

  it('a skill blocked by scan warnings cannot be selected', () => {
    state.diff = diff({
      changed: [changed('warned', { blockedByScan: true, scanWarnings: ['x'] })],
    });
    show();
    expect((screen.getByLabelText('Update warned') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('blocked by scan warnings')).toBeTruthy();
  });

  it.each([
    ['SKILL_UPDATE_STALE_SHA'],
    ['SKILL_CHANGED'],
    ['SKILL_UPDATE_DIFF_INCOMPLETE'],
    ['SKILL_UPDATE_SOURCE_CHANGED'],
  ])('409 %s tells the admin to re-open the diff, and offers a reload', async (code) => {
    accept.mockRejectedValueOnce(new ApiError('It moved.', 409, code, { names: ['a'] }));
    state.diff = diff({ changed: [changed('a')] });
    show();
    fireEvent.click(screen.getByText('Accept 1 skill'));
    expect(await screen.findByText(/Re-open the diff and review it again/)).toBeTruthy();
    fireEvent.click(screen.getByText('Reload diff'));
    expect(refetch).toHaveBeenCalled();
  });

  it('422 for scan warnings lists the reasons', async () => {
    accept.mockRejectedValueOnce(
      new ApiError('Some chosen skills drew scanner warnings', 422, 'SKILL_UPDATE_SCAN_WARNINGS', [
        { name: 'a', warnings: ['exfil:curl'] },
      ])
    );
    state.diff = diff({ changed: [changed('a')] });
    show();
    fireEvent.click(screen.getByText('Accept 1 skill'));
    expect(await screen.findByText(/drew scanner warnings/)).toBeTruthy();
    expect(screen.getByText('a: exfil:curl')).toBeTruthy();
  });

  it('reports the outcome after an accept', async () => {
    accept.mockResolvedValue(accepted({ conflicts: ['mine'], pinAdvanced: false }));
    state.diff = diff({ changed: [changed('a')] });
    show();
    fireEvent.click(screen.getByText('Accept 1 skill'));
    expect(await screen.findByText(/Updated 1 skill\(s\) to bbbbbbb/)).toBeTruthy();
    expect(screen.getByText('a: revision 3 → 4')).toBeTruthy();
    expect(screen.getByText('Left alone (edited by hand): mine')).toBeTruthy();
    expect(screen.getByText(/The pin did not move/)).toBeTruthy();
  });
});

describe('skills in the source that are not installed', () => {
  it('installs one at the pinned sha, and it leaves the list', async () => {
    state.diff = diff({ added: [added('fresh'), added('broken', { errors: ['bad'] })] });
    show();
    const broken = screen.getByLabelText('Install broken') as HTMLButtonElement;
    expect(broken.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Install fresh'));
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith({ id: 'src-1', sha: PINNED, skills: ['fresh'] })
    );
    await waitFor(() => expect(screen.queryByLabelText('Install fresh')).toBeNull());
  });

  it('explains an unknown skill (first added after the pin) and shows other refusals', async () => {
    install.mockRejectedValueOnce(
      new ApiError('unknown', 400, 'SKILL_IMPORT_UNKNOWN_SKILLS', ['fresh'])
    );
    install.mockRejectedValueOnce(
      new ApiError('Some chosen skills drew scanner warnings', 422, 'SKILL_IMPORT_SCAN_WARNINGS', [
        { name: 'fresh', warnings: ['exfil:curl'] },
      ])
    );
    state.diff = diff({ added: [added('fresh')] });
    show();
    fireEvent.click(screen.getByLabelText('Install fresh'));
    expect(await screen.findByText(/not in the commit the source is pinned to yet/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Install fresh'));
    const item = (await screen.findByText(/exfil:curl/)).closest('li') as HTMLElement;
    expect(within(item).getByText(/drew scanner warnings/)).toBeTruthy();
  });
});
