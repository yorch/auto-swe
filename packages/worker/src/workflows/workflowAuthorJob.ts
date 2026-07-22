import { ApplicationFailure, defineQuery, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import { RETRY_SINGLE_ATTEMPT, T_5M, T_30S } from './proxyOptions.js';

/**
 * WorkflowAuthorJobWorkflow — the async (non-blocking) generation job.
 *
 * The gateway STARTS this (without awaiting) and returns a job id immediately, so
 * the HTTP request doesn't block for the whole generate→persist run (avoids
 * proxy idle-timeouts). The web client then polls a status endpoint that reads
 * the `authorJobProgress` query for live phase and `handle.result()` once done.
 *
 * The job persists the DRAFT itself (worker-side) so the result is idempotent on
 * re-poll: the workflow runs once and its result — including the created
 * templateId — is stable. Like the channel path it refuses shell nodes (the
 * gateway's sync POST /generate remains the shell-capable, audited path).
 *
 * V8-isolate rule: only `import type` from activities; runtime imports come from
 * `@temporalio/workflow` and the activity proxies below.
 */

export interface WorkflowAuthorJobInput {
  prompt: string;
  teamId: string | null;
  name?: string;
  createdById?: string | null;
}

export type AuthorJobPhase = 'generating' | 'persisting' | 'done' | 'failed';

export interface WorkflowAuthorJobProgress {
  phase: AuthorJobPhase;
}

export interface WorkflowAuthorJobResult {
  templateId: string;
  name: string;
  summary: string;
  attempts: number;
}

/** Query the live phase of a running generation job. */
export const authorJobProgressQuery = defineQuery<WorkflowAuthorJobProgress>('authorJobProgress');

const { generateWorkflowSpec } = proxyActivities<
  Pick<typeof activitiesType, 'generateWorkflowSpec'>
>({
  retry: RETRY_SINGLE_ATTEMPT,
  startToCloseTimeout: T_5M,
});

const { persistDraftTemplate } = proxyActivities<
  Pick<typeof activitiesType, 'persistDraftTemplate'>
>({
  // No retry: the activity does a non-idempotent `workflowTemplate.create`, so an
  // activity-level retry after a committed-but-unacked create would persist a
  // SECOND DRAFT. One attempt; a transient failure fails the job (the user
  // retries), which is preferable to silently leaking duplicate templates.
  retry: RETRY_SINGLE_ATTEMPT,
  startToCloseTimeout: T_30S,
});

export async function WorkflowAuthorJobWorkflow(
  input: WorkflowAuthorJobInput
): Promise<WorkflowAuthorJobResult> {
  let progress: WorkflowAuthorJobProgress = { phase: 'generating' };
  setHandler(authorJobProgressQuery, () => progress);

  try {
    const gen = await generateWorkflowSpec({
      allowShell: false,
      prompt: input.prompt,
      teamId: input.teamId,
    });
    progress = { phase: 'persisting' };
    const persisted = await persistDraftTemplate({
      createdById: input.createdById,
      name: input.name,
      spec: gen.spec,
      teamId: input.teamId,
    });
    if (!persisted) {
      // The async/web path is not shell-authorized; surface a clear, distinct
      // failure so the poller can tell the user to author it on the canvas.
      throw ApplicationFailure.nonRetryable(
        'The generated workflow uses shell/container steps, which must be authored on the canvas.',
        'SHELL_NOT_ALLOWED'
      );
    }
    progress = { phase: 'done' };
    return {
      attempts: gen.attempts,
      name: persisted.name,
      summary: gen.summary,
      templateId: persisted.templateId,
    };
  } catch (err) {
    progress = { phase: 'failed' };
    throw err;
  }
}
