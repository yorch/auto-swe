/**
 * The `github.workflow_run.failed` event source's webhook side: a `workflow_run` delivery
 * normalized into an occurrence for the engine. Everything that is never acted on is ignored
 * here, before any query.
 */
import type { WorkflowRunFailedFacts } from '@auto-swe/shared/automation';
import { CI_TRIGGER_EVENTS } from '@auto-swe/shared/lib/ciTrigger';
import { isSafeGitBranchName } from '@auto-swe/shared/lib/gitRef';
import { z } from 'zod';
import type { Occurrence } from './engine.js';

const WorkflowRunWebhookSchema = z.object({
  action: z.string(),
  repository: z.object({
    full_name: z.string(),
    html_url: z.string().optional(),
    id: z.number(),
  }),
  workflow_run: z.object({
    conclusion: z.string().nullish(),
    event: z.string(),
    head_branch: z.string().nullish(),
    head_repository: z.object({ full_name: z.string(), id: z.number() }).nullish(),
    head_sha: z.string(),
    html_url: z.string().optional(),
    id: z.number().int().positive(),
    path: z.string(),
    pull_requests: z
      .array(
        z.object({
          base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }).nullish() }),
          head: z.object({ ref: z.string(), repo: z.object({ id: z.number() }).nullish() }),
          number: z.number().int().positive(),
        })
      )
      .nullish(),
    run_attempt: z.number().int().min(1).optional(),
    status: z.string().nullish(),
  }),
});

export type WorkflowRunEvent =
  | ({ type: 'failed' } & Occurrence<WorkflowRunFailedFacts>)
  | { type: 'unrecognized' }
  | { type: 'ignored'; reason: string };

/** Pure mapping from a `workflow_run` webhook body to the failure an automation may act on. */
export function normalizeWorkflowRunEvent(body: unknown): WorkflowRunEvent {
  const parsed = WorkflowRunWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const { action, repository, workflow_run: run } = parsed.data;
  if (action !== 'completed') {
    return { reason: `action ${action}`, type: 'ignored' };
  }
  if (run.conclusion !== 'failure' && run.conclusion !== 'timed_out') {
    return { reason: `conclusion ${run.conclusion ?? 'none'}`, type: 'ignored' };
  }
  if (!(CI_TRIGGER_EVENTS as readonly string[]).includes(run.event)) {
    return { reason: `event ${run.event} is never acted on`, type: 'ignored' };
  }
  // A fork's code, a fork's logs: never. Compared by id, which a rename cannot change.
  if (!run.head_repository || run.head_repository.id !== repository.id) {
    return { reason: 'the run is for a commit from a fork', type: 'ignored' };
  }
  const branch = run.head_branch ?? '';
  if (!isSafeGitBranchName(branch)) {
    return { reason: 'the run names no usable branch', type: 'ignored' };
  }
  const [org, repoName] = repository.full_name.split('/');
  if (!org || !repoName) {
    return { type: 'unrecognized' };
  }
  let pullRequestNumber: number | null = null;
  if (run.event === 'pull_request') {
    // The pull request from this branch of this repository. GitHub lists none for a fork, may
    // list none once it closed, and may list several (one per base); the first is used.
    const pr = (run.pull_requests ?? []).find(
      (p) => p.head.ref === branch && p.head.repo?.id === repository.id
    );
    pullRequestNumber = pr?.number ?? null;
  }
  return {
    facts: {
      branch,
      event: run.event,
      headSha: run.head_sha,
      pullRequestNumber,
      runAttempt: run.run_attempt ?? 1,
      runId: String(run.id),
      // Bounded for the ledger; a longer path is still the run's, and still triaged.
      workflowPath: run.path.slice(0, 500),
    },
    org,
    repoFullName: repository.full_name,
    repoHtmlUrl: repository.html_url,
    repoName,
    type: 'failed',
  };
}
