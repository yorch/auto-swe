/**
 * Workflow bundle for `campaign.workflow.test.ts`: the real campaign workflow, plus a stand-in
 * `RunnableWorkflow` child whose behaviour a fake activity scripts per repository
 * (`request.repoId`):
 *  - `{ kind: 'result', delayMs, result }` — sleep, then return `{ ...result, status }`;
 *  - `{ kind: 'reject', delayMs }` — sleep, then fail the child with a non-retryable error;
 *  - `{ kind: 'park' }` (the default) — run until cancelled and report the cancellation.
 * Test-only — not part of the worker's `index.ts` barrel.
 */
import {
  ApplicationFailure,
  CancellationScope,
  condition,
  isCancellation,
  proxyActivities,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';

export { CampaignWorkflow, campaignCancelSignal } from '../campaign.js';

export interface ChildScript {
  kind: 'result' | 'reject' | 'park';
  delayMs?: number;
  result?: Record<string, unknown>;
}

const { childBegan, childCancelled, childEnded, scriptFor } = proxyActivities<{
  /** Reports what the campaign started this child with, and returns what it should do. */
  scriptFor(input: {
    payload: unknown;
    repoId: string;
    templateId: string;
    templateVersion: number;
    workflowId: string;
  }): Promise<ChildScript>;
  childBegan(workflowId: string): Promise<void>;
  childEnded(workflowId: string): Promise<void>;
  childCancelled(workflowId: string): Promise<void>;
}>({ startToCloseTimeout: '10m' });

export async function RunnableWorkflow(input: {
  request?: { payload?: unknown; repoId?: string };
  templateId: string;
  templateVersion: number;
}): Promise<Record<string, unknown>> {
  const workflowId = workflowInfo().workflowId;
  const script = await scriptFor({
    payload: input.request?.payload,
    repoId: input.request?.repoId ?? '',
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    workflowId,
  });
  await childBegan(workflowId);
  try {
    if (script.kind === 'park') {
      await condition(() => false);
    }
    await sleep(script.delayMs ?? 1000);
    if (script.kind === 'reject') {
      throw ApplicationFailure.nonRetryable('PROTECTED_TESTS_UNAVAILABLE: no merge base');
    }
    await childEnded(workflowId);
    return {
      lessonsGenerated: [],
      totalCIRetries: 0,
      totalReviewRetries: 0,
      ...script.result,
      status: script.result?.status ?? 'SUCCESS',
    };
  } catch (err) {
    if (isCancellation(err)) {
      await CancellationScope.nonCancellable(() => childCancelled(workflowId));
    } else {
      await CancellationScope.nonCancellable(() => childEnded(workflowId));
    }
    throw err;
  }
}
