// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSource } from '@/hooks/useSkillSources';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const source = (over: Partial<SkillSource>): SkillSource => ({
  host: 'github.com',
  id: 'src-1',
  lastCheckedAt: '2026-10-02T04:00:00Z',
  lastError: null,
  latestSha: SHA_A,
  orgId: null,
  owner: 'acme',
  path: 'skills',
  pinnedSha: SHA_A,
  ref: 'main',
  repo: 'agent-skills',
  scope: 'GLOBAL',
  scriptMode: 'TEXT_ONLY',
  skillCount: 3,
  status: 'OK',
  teamId: null,
  ...over,
});

const { check, patch, remove, state } = vi.hoisted(() => ({
  check: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  state: { rows: [] as unknown[] },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useSkillSources', () => ({
  useCheckSource: () => ({ isPending: false, mutateAsync: check }),
  useDeleteSource: () => ({ isPending: false, mutateAsync: remove }),
  usePatchSource: () => ({ isPending: false, mutateAsync: patch }),
  useSkillSources: () => ({ data: state.rows, error: null, isError: false, isLoading: false }),
}));
// The two modals have their own suites.
vi.mock('./AddSourceModal', () => ({
  AddSourceModal: ({ open }: { open: boolean }) => (open ? <div>add-source-modal</div> : null),
}));
vi.mock('./ReviewUpdateModal', () => ({
  ReviewUpdateModal: ({ sourceId }: { sourceId: string | null }) =>
    sourceId ? <div>review-modal:{sourceId}</div> : null,
}));

const { SkillSourcesTab } = await import('./SkillSourcesTab');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue({ check: { error: null, status: 'OK' }, recorded: true });
  patch.mockResolvedValue({});
  remove.mockResolvedValue(undefined);
  state.rows = [
    source({}),
    source({
      id: 'src-2',
      lastError: 'The host refused the request',
      latestSha: SHA_B,
      owner: 'zed',
      scriptMode: 'REJECT',
      status: 'UPDATE_AVAILABLE',
    }),
    source({ id: 'src-3', owner: 'off', status: 'DISABLED' }),
  ];
});

const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

/** Opens a row's overflow menu and chooses one item from it. */
function menuAction(row: HTMLElement, item: string) {
  fireEvent.click(within(row).getByRole('button', { name: /^More actions for/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
}

describe('SkillSourcesTab', () => {
  it('lists location, ref, short pinned and latest sha, status, last error and script mode', () => {
    render(<SkillSourcesTab />);
    const row = rowOf('github.com/zed/agent-skills/skills');
    expect(within(row).getByText('Update available')).toBeTruthy();
    expect(row.textContent).toContain('aaaaaaa / bbbbbbb');
    expect(within(row).getByText('The host refused the request')).toBeTruthy();
    expect(within(row).getByText('Reject scripts')).toBeTruthy();
    expect(within(row).getByText(/ref main · 3 skills/)).toBeTruthy();
    expect(
      within(rowOf('github.com/acme/agent-skills/skills')).getByText('Up to date')
    ).toBeTruthy();
    expect(within(rowOf('github.com/off/agent-skills/skills')).getByText('Disabled')).toBeTruthy();
  });

  it('offers Review update only for a source with an update', () => {
    render(<SkillSourcesTab />);
    expect(screen.getAllByText('Review update')).toHaveLength(1);
    fireEvent.click(within(rowOf('github.com/zed/agent-skills/skills')).getByText('Review update'));
    expect(screen.getByText('review-modal:src-2')).toBeTruthy();
  });

  it('checks now, and says so when the check was not recorded', async () => {
    check.mockResolvedValueOnce({ check: { error: null, status: 'OK' }, recorded: false });
    render(<SkillSourcesTab />);
    fireEvent.click(within(rowOf('github.com/acme/agent-skills/skills')).getByText('Check now'));
    await waitFor(() => expect(check).toHaveBeenCalledWith('src-1'));
    expect(await screen.findByText(/Not recorded: the source changed/)).toBeTruthy();
  });

  it('cannot check a disabled source, and enables it with status OK', async () => {
    render(<SkillSourcesTab />);
    const row = rowOf('github.com/off/agent-skills/skills');
    expect((within(row).getByText('Check now') as HTMLButtonElement).disabled).toBe(true);
    menuAction(row, 'Enable');
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ id: 'src-3', status: 'OK' }));
  });

  it('disables a source and switches the script mode', async () => {
    render(<SkillSourcesTab />);
    const row = rowOf('github.com/acme/agent-skills/skills');
    menuAction(row, 'Disable');
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ id: 'src-1', status: 'DISABLED' }));
    menuAction(row, 'Reject scripts');
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ id: 'src-1', scriptMode: 'REJECT' }));
    menuAction(rowOf('github.com/zed/agent-skills/skills'), 'Allow text files');
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({ id: 'src-2', scriptMode: 'TEXT_ONLY' })
    );
  });

  it('confirms a delete, saying the skills are detached and kept', async () => {
    render(<SkillSourcesTab />);
    menuAction(rowOf('github.com/acme/agent-skills/skills'), 'Delete');
    expect(screen.getByText(/detached and kept as ordinary custom skills/)).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Delete source'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('src-1'));
  });

  it('shows repository-controlled text with hidden characters made visible', () => {
    state.rows = [source({ owner: 'ev‮il', ref: 'ma​in' })];
    render(<SkillSourcesTab />);
    expect(screen.getByText('github.com/ev⟨U+202E⟩il/agent-skills/skills')).toBeTruthy();
    expect(screen.getByText(/ref ma⟨U\+200B⟩in/)).toBeTruthy();
  });

  it('opens the add flow', () => {
    state.rows = [];
    render(<SkillSourcesTab />);
    expect(screen.getByText(/No external sources yet/)).toBeTruthy();
    fireEvent.click(screen.getByText('Add source'));
    expect(screen.getByText('add-source-modal')).toBeTruthy();
  });
});
