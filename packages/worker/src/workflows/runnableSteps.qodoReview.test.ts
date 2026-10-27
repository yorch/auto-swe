import { describe, expect, it, vi } from 'vitest';

const awaitQodoReview = vi.fn(async (_input: unknown) => ({ status: 'reviewed' }));

vi.mock('./runnableActivities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runnableActivities.js')>();
  return { ...actual, qodoReviewActivities: { awaitQodoReview } };
});

const { dispatchStepImpl } = await import('./runnableSteps.js');

const ctx = { workflow: { id: 'wf-1' } } as never;

describe('the awaitQodoReview step', () => {
  it('runs through its own activity group with the run’s repository and the bound inputs', async () => {
    await dispatchStepImpl(
      'awaitQodoReview',
      ctx,
      { repoId: 'repo-1' } as never,
      { minActionLevel: 'action_required', waitSeconds: 30 },
      { headSha: 'abc', prUrl: 'https://ghe.example.test/acme/api/pull/3' },
      'qodo'
    );
    expect(awaitQodoReview).toHaveBeenCalledWith({
      headSha: 'abc',
      minActionLevel: 'action_required',
      prUrl: 'https://ghe.example.test/acme/api/pull/3',
      repoId: 'repo-1',
      waitSeconds: 30,
    });
  });

  it('never takes the repository or a connection from the config or the inputs', async () => {
    awaitQodoReview.mockClear();
    await dispatchStepImpl(
      'awaitQodoReview',
      ctx,
      { repoId: 'repo-1' } as never,
      { connectionId: 'c-x', repoId: 'repo-x', teamId: 't-x' },
      { connectionId: 'c-y', repoId: 'repo-y', teamId: 't-y' },
      'qodo'
    );
    const call = JSON.stringify(awaitQodoReview.mock.calls[0]);
    expect(call).toContain('repo-1');
    expect(call).not.toMatch(/-x|-y/);
  });
});
