import { describe, expect, it } from 'vitest';
import { normalizeWorkflowRunEvent } from './workflowRunFailed.js';

const REPO_ID = 42;

function body(over: Record<string, unknown> = {}, run: Record<string, unknown> = {}) {
  return {
    action: 'completed',
    repository: { full_name: 'acme/api', html_url: 'https://github.com/acme/api', id: REPO_ID },
    workflow_run: {
      conclusion: 'failure',
      event: 'push',
      head_branch: 'release/1.4',
      head_repository: { full_name: 'acme/api', id: REPO_ID },
      head_sha: 'a'.repeat(40),
      id: 123456789012,
      path: '.github/workflows/ci.yml',
      pull_requests: [],
      run_attempt: 1,
      status: 'completed',
      ...run,
    },
    ...over,
  };
}

describe('normalizeWorkflowRunEvent', () => {
  it('maps a failed push run', () => {
    expect(normalizeWorkflowRunEvent(body())).toMatchObject({
      facts: {
        branch: 'release/1.4',
        event: 'push',
        pullRequestNumber: null,
        runAttempt: 1,
        runId: '123456789012',
        workflowPath: '.github/workflows/ci.yml',
      },
      org: 'acme',
      repoName: 'api',
      type: 'failed',
    });
  });

  it.each([
    ['a run that has not completed', body({ action: 'requested' })],
    ['a passing run', body({}, { conclusion: 'success' })],
    ['a cancelled run', body({}, { conclusion: 'cancelled' })],
    ['a startup failure (no logs)', body({}, { conclusion: 'startup_failure' })],
    ['pull_request_target', body({}, { event: 'pull_request_target' })],
    ['a schedule', body({}, { event: 'schedule' })],
    ['workflow_dispatch', body({}, { event: 'workflow_dispatch' })],
    ['merge_group', body({}, { event: 'merge_group' })],
    ['a fork', body({}, { head_repository: { full_name: 'mallory/api', id: 7 } })],
    [
      'a fork renamed to the same name',
      body({}, { head_repository: { full_name: 'acme/api', id: 7 } }),
    ],
    ['a deleted fork', body({}, { head_repository: null })],
    ['no branch', body({}, { head_branch: null })],
    ['a branch name that is not safe', body({}, { head_branch: '-x' })],
  ])('ignores %s', (_label, payload) => {
    expect(normalizeWorkflowRunEvent(payload).type).toBe('ignored');
  });

  it('is unrecognized for another shape', () => {
    expect(normalizeWorkflowRunEvent({ check_run: {} }).type).toBe('unrecognized');
  });

  it('finds the same-repository pull request from the failing branch', () => {
    const pr = (n: number, ref: string, repoId: number) => ({
      base: { ref: 'main', repo: { id: REPO_ID } },
      head: { ref, repo: { id: repoId } },
      number: n,
    });
    const event = normalizeWorkflowRunEvent(
      body(
        {},
        {
          event: 'pull_request',
          head_branch: 'feat/x',
          pull_requests: [pr(1, 'other', REPO_ID), pr(2, 'feat/x', 99), pr(3, 'feat/x', REPO_ID)],
        }
      )
    );
    expect(event).toMatchObject({ facts: { pullRequestNumber: 3 }, type: 'failed' });
  });

  it('has no pull request when GitHub lists none', () => {
    const event = normalizeWorkflowRunEvent(
      body({}, { event: 'pull_request', head_branch: 'feat/x' })
    );
    expect(event).toMatchObject({ facts: { pullRequestNumber: null }, type: 'failed' });
  });
});
