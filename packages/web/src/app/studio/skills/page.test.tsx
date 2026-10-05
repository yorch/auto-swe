// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from '@/hooks/useSkills';
import { ApiError } from '@/lib/api';

const skill = (over: Partial<Skill>): Skill => ({
  createdAt: '2026-10-01T00:00:00Z',
  currentRevision: 1,
  description: 'does a thing',
  externalSource: null,
  id: 's1',
  isActive: true,
  isBuiltIn: false,
  isVerified: false,
  name: 'custom',
  origin: null,
  promptText: 'text',
  updatedAt: '2026-10-01T00:00:00Z',
  usedByCount: 0,
  ...over,
});

const { state, verify } = vi.hoisted(() => ({
  state: { admin: true, skills: [] as unknown[] },
  verify: vi.fn(),
}));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => state.admin }));
vi.mock('@/hooks/useSkills', () => ({
  useCreateSkill: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useDeleteSkill: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useSkillEffectiveness: () => ({
    data: { baselineSuccessRate: null, perSkill: [], totalRuns: 0, windowDays: 30 },
    error: null,
    isError: false,
    isLoading: false,
  }),
  useSkills: () => ({ data: state.skills, error: null, isError: false, isLoading: false }),
  useUpdateSkill: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useVerifySkill: () => ({ isPending: false, mutateAsync: verify }),
}));
vi.mock('@/components/skills/SkillSourcesTab', () => ({
  SkillSourcesTab: () => <div>external-sources-tab</div>,
}));

const { default: StudioSkillsPage } = await import('./page');

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
  state.admin = true;
  verify.mockResolvedValue({});
  state.skills = [
    skill({
      currentRevision: 4,
      externalSource: { host: 'github.com', owner: 'acme', repo: 'pack', sha: 'abcdef0123456789' },
      id: 'imported',
      name: 'imported',
    }),
    skill({ id: 'verified', isVerified: true, name: 'trusted' }),
  ];
});

const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

describe('Skills studio page', () => {
  it('badges an imported skill with its repository and short sha, and shows its verified state', () => {
    render(<StudioSkillsPage />);
    const row = rowOf('imported');
    expect(within(row).getByText('external: acme/pack@abcdef0')).toBeTruthy();
    expect(within(row).getByText('unverified')).toBeTruthy();
    expect(within(row).getByText('rev 4')).toBeTruthy();
    expect(within(rowOf('trusted')).getByText('verified')).toBeTruthy();
  });

  const open = (name: string) => fireEvent.click(within(rowOf(name)).getByText('View / Edit'));

  it('offers no Verify in the list: only after opening the skill and its text', () => {
    render(<StudioSkillsPage />);
    expect(screen.queryByText(/^Verify/)).toBeNull();
  });

  it('verifies, from the detail modal beside the text, the revision that modal shows', async () => {
    render(<StudioSkillsPage />);
    open('imported');
    expect(screen.getByText('text')).toBeTruthy();
    fireEvent.click(screen.getByText('Verify revision 4'));
    await waitFor(() => expect(verify).toHaveBeenCalledWith({ id: 'imported', revision: 4 }));
  });

  it('does not offer Verify on an already verified skill', () => {
    render(<StudioSkillsPage />);
    open('trusted');
    expect(screen.queryByText(/^Verify revision/)).toBeNull();
  });

  it('a 409 on verify says the skill changed and to open it again', async () => {
    verify.mockRejectedValueOnce(new ApiError('changed', 409, 'SKILL_CHANGED'));
    render(<StudioSkillsPage />);
    open('imported');
    fireEvent.click(screen.getByText('Verify revision 4'));
    expect(await screen.findByText(/changed since you opened it/)).toBeTruthy();
  });

  it('never swaps the open text for a newer revision: shows a notice, and Reload reads it', async () => {
    const { rerender } = render(<StudioSkillsPage />);
    open('imported');
    state.skills = [
      skill({ currentRevision: 5, id: 'imported', name: 'imported', promptText: 'newer text' }),
    ];
    rerender(<StudioSkillsPage />);
    expect(screen.getByText('text')).toBeTruthy();
    expect(screen.queryByText('newer text')).toBeNull();
    expect(screen.getByText(/changed since you opened it — reload/)).toBeTruthy();
    expect(screen.queryByText('Verify revision 4')).toBeNull();
    fireEvent.click(screen.getByText('Reload'));
    expect(screen.getByText('newer text')).toBeTruthy();
    fireEvent.click(screen.getByText('Verify revision 5'));
    await waitFor(() => expect(verify).toHaveBeenCalledWith({ id: 'imported', revision: 5 }));
  });

  it('shows hidden characters in skill names and descriptions', () => {
    state.skills = [skill({ description: 'a‮b', name: 'na​me' })];
    render(<StudioSkillsPage />);
    expect(screen.getByText('na⟨U+200B⟩me')).toBeTruthy();
    expect(screen.getByText('a⟨U+202E⟩b')).toBeTruthy();
  });

  it('shows the External sources tab to an admin only', () => {
    render(<StudioSkillsPage />);
    fireEvent.click(screen.getByText('External sources'));
    expect(screen.getByText('external-sources-tab')).toBeTruthy();
  });

  it('hides the tab, and Verify, from a non-admin', () => {
    state.admin = false;
    render(<StudioSkillsPage />);
    expect(screen.queryByText('External sources')).toBeNull();
    open('imported');
    expect(screen.queryByText(/^Verify revision/)).toBeNull();
  });
});
