// @vitest-environment jsdom
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dismiss: vi.fn() }));
vi.mock('@/hooks/useRepositoryOnboarding', () => ({
  useDismissOnboardingChecklist: () => ({ isPending: false, mutateAsync: h.dismiss }),
}));

import { RepoOnboardingChecklist } from './RepoOnboardingChecklist';

const checklist = {
  accessVerified: false,
  dismissed: false,
  firstRunLaunched: false,
  onboardingPrOpened: false,
  onboardingPrUrl: null,
  setupHealthy: true,
  stackScanned: false,
};
const repo = {
  id: 'repo',
  onboardingChecklist: checklist,
  team: { id: 'team' },
  type: 'git_repo',
} as RepositorySummary;
const callbacks = {
  onOnboardingPr: vi.fn(),
  onSetup: vi.fn(),
  onStack: vi.fn(),
  onTestAccess: vi.fn(),
};
afterEach(cleanup);
beforeEach(() => {
  h.dismiss.mockReset().mockResolvedValue({});
  Object.values(callbacks).forEach((fn) => {
    fn.mockClear();
  });
});
describe('repository first-run checklist', () => {
  it('renders progress and connects items to actions', () => {
    render(<RepoOnboardingChecklist {...callbacks} canManage repo={repo} />);
    fireEvent.click(screen.getByText('First-run checklist'));
    fireEvent.click(screen.getByRole('button', { name: 'Access tested OK' }));
    expect(callbacks.onTestAccess).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Onboarding PR opened' }));
    expect(callbacks.onOnboardingPr).toHaveBeenCalled();
    expect(screen.getAllByLabelText('Complete')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'First run launched' }).getAttribute('href')).toBe(
      '/start?team=team'
    );
  });
  it('dismisses and hides only after success', async () => {
    render(<RepoOnboardingChecklist {...callbacks} canManage repo={repo} />);
    fireEvent.click(screen.getByText('First-run checklist'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss checklist' }));
    await waitFor(() => expect(screen.queryByText('First-run checklist')).toBeNull());
    expect(h.dismiss).toHaveBeenCalledTimes(1);
  });
  it('keeps the checklist when dismissal fails', async () => {
    h.dismiss.mockRejectedValue(new Error('Cannot dismiss'));
    render(<RepoOnboardingChecklist {...callbacks} canManage repo={repo} />);
    fireEvent.click(screen.getByText('First-run checklist'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss checklist' }));
    expect(await screen.findByText('Cannot dismiss')).toBeTruthy();
    expect(screen.getByText('First-run checklist')).toBeTruthy();
  });
  it.each([
    { canManage: false, repo },
    { canManage: true, repo: { ...repo, type: 'mcp' } },
    { canManage: true, repo: { ...repo, onboardingChecklist: undefined } },
    { canManage: true, repo: { ...repo, onboardingChecklist: { ...checklist, dismissed: true } } },
    {
      canManage: true,
      repo: {
        ...repo,
        onboardingChecklist: {
          ...checklist,
          accessVerified: true,
          firstRunLaunched: true,
          onboardingPrOpened: true,
          stackScanned: true,
        },
      },
    },
  ])('hides unavailable, dismissed and complete checklists %#', (props) => {
    render(<RepoOnboardingChecklist {...callbacks} {...props} />);
    expect(screen.queryByText('First-run checklist')).toBeNull();
  });
});
