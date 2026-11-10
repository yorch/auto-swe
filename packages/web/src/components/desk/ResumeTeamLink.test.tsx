// @vitest-environment jsdom

import type { TeamSummary } from '@auto-swe/shared/types/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useUserPreferences = vi.fn();
vi.mock('@/hooks/useUserPreferences', () => ({
  useUserPreferences: () => useUserPreferences(),
}));
const useTeams = vi.fn();
vi.mock('@/hooks/useTeams', () => ({
  useTeams: (...args: unknown[]) => useTeams(...args),
}));

import { ResumeTeamLink } from './ResumeTeamLink';

const team = (overrides: Partial<TeamSummary> = {}): TeamSummary => ({
  _count: { memberships: 2, repositories: 1 },
  defaultPersonaPrompt: null,
  description: '',
  id: 't1',
  myRole: 'ENGINEER',
  name: 'Payments',
  orgId: 'o1',
  orgName: 'Acme',
  slug: 'payments',
  ...overrides,
});

const prefs = (lastTeamSlug: string | null | undefined, loaded = true) => ({
  lastTeamSlug,
  loaded,
});

const ok = (data: TeamSummary[]) => ({ data, isError: false, isSuccess: true });

beforeEach(() => {
  useUserPreferences.mockReturnValue(prefs('payments'));
  useTeams.mockReturnValue(ok([team()]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ResumeTeamLink', () => {
  it('links to the last-visited team the caller is a member of', () => {
    render(<ResumeTeamLink />);
    const link = screen.getByRole('link', { name: 'Continue in Payments' });
    expect(link.getAttribute('href')).toBe('/teams/payments');
  });

  it('resolves the slug only through the member-filtered team list', () => {
    render(<ResumeTeamLink />);
    expect(useTeams).toHaveBeenCalledWith({ memberOnly: true });
  });

  it('renders nothing when the slug is not one of the caller’s member teams', () => {
    useUserPreferences.mockReturnValue(prefs('elsewhere'));
    const { container } = render(<ResumeTeamLink />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when no team is remembered', () => {
    useUserPreferences.mockReturnValue(prefs(null));
    const { container } = render(<ResumeTeamLink />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing while the preference has not loaded', () => {
    useUserPreferences.mockReturnValue(prefs('payments', false));
    const { container } = render(<ResumeTeamLink />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing while the team list is loading', () => {
    useTeams.mockReturnValue({ data: undefined, isError: false, isSuccess: false });
    const { container } = render(<ResumeTeamLink />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the team list fails, even with earlier data', () => {
    useTeams.mockReturnValue({ data: [team()], isError: true, isSuccess: false });
    const { container } = render(<ResumeTeamLink />);
    expect(container.innerHTML).toBe('');
  });
});
