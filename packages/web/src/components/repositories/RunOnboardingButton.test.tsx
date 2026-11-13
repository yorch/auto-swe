// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { setupDraft } from '@/lib/repoSetupDraft';
import { withQuery } from '@/test/rtl-helpers';
import { RepoSetupEditor } from './RepoSetupEditor';
import { RunOnboardingButton } from './RunOnboardingButton';

vi.mock('./RepoSetupHealth', () => ({ RepoSetupHealth: () => null }));
vi.mock('./RepoSetupSecrets', () => ({ RepoSetupSecrets: () => null }));
vi.mock('./RepoEvalDatasets', () => ({ RepoEvalDatasets: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Run onboarding button', () => {
  it('the saved setup editor mirrors its setup-author permission', () => {
    const props = {
      detectedStack: null,
      draft: setupDraft(null),
      onChange: vi.fn(),
      repositoryId: 'repo-1',
    };
    const { rerender } = render(withQuery(<RepoSetupEditor {...props} disabled />));
    expect(screen.queryByRole('button', { name: 'Run onboarding' })).toBeNull();
    rerender(withQuery(<RepoSetupEditor {...props} disabled={false} />));
    expect(screen.getByRole('button', { name: 'Run onboarding' })).toBeTruthy();
  });
  it('is hidden without setup-author permission', () => {
    render(withQuery(<RunOnboardingButton canRun={false} repositoryId="repo-1" />));
    expect(screen.queryByRole('button', { name: 'Run onboarding' })).toBeNull();
  });
  it.each(['run-1', null])('links the run or pending request after success: %s', async (runId) => {
    const post = vi.spyOn(api, 'fetch').mockResolvedValue({
      data: {
        runId,
        temporalWorkflowId: 'wf-1',
        workflowId: 'active-1',
        workRequestId: 'request-1',
      },
    });
    render(withQuery(<RunOnboardingButton canRun repositoryId="repo-1" />));
    fireEvent.click(screen.getByRole('button', { name: 'Run onboarding' }));
    const link = await screen.findByRole('link', { name: 'View onboarding run' });
    expect(link.getAttribute('href')).toBe(runId ? '/runs/run-1' : '/requests/request-1');
    expect(post).toHaveBeenCalledWith(
      '/api/v1/repositories/repo-1/onboarding-runs',
      expect.objectContaining({
        headers: { 'Idempotency-Key': expect.any(String) },
        method: 'POST',
      })
    );
  });
  it('shows failure and retains the idempotency key for a retry', async () => {
    const post = vi.spyOn(api, 'fetch').mockRejectedValue(new Error('Budget exceeded'));
    render(withQuery(<RunOnboardingButton canRun repositoryId="repo-1" />));
    fireEvent.click(screen.getByRole('button', { name: 'Run onboarding' }));
    expect(await screen.findByText('Budget exceeded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run onboarding' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[0]?.[1]?.headers).toEqual(post.mock.calls[1]?.[1]?.headers);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
