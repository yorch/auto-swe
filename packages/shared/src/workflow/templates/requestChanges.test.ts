import { describe, expect, it } from 'vitest';
import type { Context } from '../expr.js';
import { type Dispatcher, runSpec } from '../interpreter.js';
import type { WorkflowSpec } from '../spec.js';
import { APPROVE_BEFORE_PR_SPEC } from './approveBeforePr.js';
import { FOUR_EYES_SPEC } from './fourEyes.js';
import { FULLY_SUPERVISED_SPEC } from './fullySupervised.js';

/**
 * The `request_changes` loop of the three built-in templates that offer it,
 * run through the real interpreter. Signals are answered from FIFO queues
 * keyed by signal name (`hitl_<nodeId>` for gates, `ciPipelineSignal` for CI);
 * an empty queue means the wait times out.
 *
 * Steps are faked by name: every fix session returns a fresh head, and the
 * `rejectionSummary` it was handed is recorded.
 */

const CHANGES = 'Add a test for the empty case';

interface Run {
  fixSummaries: string[];
  notified: string[];
  result: Awaited<ReturnType<typeof runSpec>>;
}

async function runTemplate(spec: WorkflowSpec, signals: Record<string, unknown[]>): Promise<Run> {
  const fixSummaries: string[] = [];
  const notified: string[] = [];
  let pushes = 0;
  const dispatcher: Dispatcher = {
    async dispatchStep({ step, inputs }) {
      switch (step) {
        case 'commitToMemory':
          return 'lesson-1';
        case 'createOrUpdatePullRequest':
          return { prNumber: 42, prUrl: 'https://example.test/pr/42' };
        case 'executeCIFixImplementation':
        case 'executeImplementation':
        case 'runAgentNode':
          pushes += 1;
          return { branch: 'auto/T-1', headSha: `sha-${pushes}` };
        case 'executeReviewFixImplementation':
          fixSummaries.push(String(inputs.rejectionSummary));
          pushes += 1;
          return { branch: 'auto/T-1', headSha: `sha-${pushes}` };
        case 'fetchCILogs':
          return 'lint failed';
        case 'gatherTicketContext':
          return { text: '' };
        case 'resolveCiWaitConfig':
          return { deadlineSec: 600, graceSec: 60, intervalSec: 15, mode: 'signal' };
        case 'runReviewNetwork':
          return { approved: true, rejectionSummary: '', verdicts: [] };
        case 'storeContextOverflowBatch':
          return [];
        case 'updateDomainState':
          return undefined;
        case 'validateContext':
          return { contextSnapshotId: 'cs-1', successCriteria: ['builds'] };
        default:
          return { passed: true };
      }
    },
    async notifyHumanStep(args) {
      notified.push(args.nodeId);
    },
    async recordStep() {},
    async resolveHumanStep() {},
    async waitSignal(name) {
      const q = signals[name];
      return q && q.length > 0 ? q.shift() : undefined;
    },
  };
  const ctx: Context = {
    context: {},
    nodes: {},
    request: { externalTicketId: 'T-1', repoId: 'repo-1' },
    workflow: { id: 'w-1' },
  };
  const result = await runSpec(spec, ctx, dispatcher);
  return { fixSummaries, notified, result };
}

const ciGreen = (times = 1) => ({
  ciPipelineSignal: Array.from({ length: times }, () => ({ passed: true })),
});
const changes = (comment = CHANGES) => ({ action: 'request_changes', comment });

describe('approve-before-pr: request changes', () => {
  const gate = (action: unknown) => ({ hitl_approve: [action] });

  it('request changes fixes and re-tests the code, then asks again', async () => {
    const { fixSummaries, notified, result } = await runTemplate(APPROVE_BEFORE_PR_SPEC, {
      hitl_approve: [changes(), { action: 'approve' }],
      ...ciGreen(),
    });
    expect(result.status).toBe('SUCCESS');
    expect(notified.filter((n) => n === 'approve')).toHaveLength(2);
    expect(fixSummaries).toEqual([CHANGES]);
  });

  it('exposes the request-changes comment at nodes.<gate>.output.comment', async () => {
    // The gate's output holds the answer that resolved it; the note nodes /
    // fix inputs read the comment off it before the next round overwrites it.
    const { result } = await runTemplate(APPROVE_BEFORE_PR_SPEC, {
      hitl_approve: [changes(), changes(), changes()],
    });
    expect(result.status).toBe('FAILED');
    const nodes = result.finalContext.nodes as Record<string, { output?: { comment?: string } }>;
    expect(nodes.approve?.output?.comment).toBe(CHANGES);
  });

  it('fails the run on the third change request', async () => {
    const { fixSummaries, result } = await runTemplate(APPROVE_BEFORE_PR_SPEC, {
      hitl_approve: [changes(), changes(), changes()],
    });
    expect(result.status).toBe('FAILED');
    expect(fixSummaries).toHaveLength(2);
  });

  it('fails the run on reject', async () => {
    const { result } = await runTemplate(APPROVE_BEFORE_PR_SPEC, gate({ action: 'reject' }));
    expect(result.status).toBe('FAILED');
  });
});

describe('fully-supervised: request changes at the final gate', () => {
  // input -> implement -> review -> decision -> finalApproval: the early human
  // steps are skipped by timing them out (empty queues).
  const answers = (finalGate: unknown[]) => ({ hitl_finalApproval: finalGate });

  it('request changes fixes the code and asks again, with the note as the summary', async () => {
    const { fixSummaries, notified, result } = await runTemplate(
      FULLY_SUPERVISED_SPEC,
      answers([changes(), { action: 'approve' }])
    );
    expect(result.status).toBe('SUCCESS');
    expect(notified.filter((n) => n === 'finalApproval')).toHaveLength(2);
    expect(fixSummaries).toEqual([CHANGES]);
  });

  it('fails the run on the third change request', async () => {
    const { fixSummaries, result } = await runTemplate(
      FULLY_SUPERVISED_SPEC,
      answers([changes(), changes(), changes()])
    );
    expect(result.status).toBe('FAILED');
    expect(fixSummaries).toHaveLength(2);
  });

  it('fails the run on reject', async () => {
    const { result } = await runTemplate(FULLY_SUPERVISED_SPEC, answers([{ action: 'reject' }]));
    expect(result.status).toBe('FAILED');
  });
});

describe('four-eyes: request changes at either sign-off', () => {
  const green = (signoffs: Record<string, unknown[]>) => ({
    ...ciGreen(),
    hitl_firstSignoff: [{ action: 'approve' }],
    hitl_secondSignoff: [{ action: 'approve' }],
    ...signoffs,
  });

  it('request changes at the first gate fixes, re-runs CI and asks both again', async () => {
    const { fixSummaries, notified, result } = await runTemplate(
      FOUR_EYES_SPEC,
      green({
        hitl_firstSignoff: [changes(), { action: 'approve' }],
        ciPipelineSignal: [{ passed: true }, { passed: true }],
      })
    );
    expect(result.status).toBe('SUCCESS');
    expect(notified.filter((n) => n === 'firstSignoff')).toHaveLength(2);
    expect(notified.filter((n) => n === 'secondSignoff')).toHaveLength(1);
    expect(fixSummaries).toEqual([CHANGES]);
  });

  it('request changes at the second gate asks the first again too', async () => {
    const { fixSummaries, notified, result } = await runTemplate(
      FOUR_EYES_SPEC,
      green({
        ciPipelineSignal: [{ passed: true }, { passed: true }],
        hitl_firstSignoff: [{ action: 'approve' }, { action: 'approve' }],
        hitl_secondSignoff: [changes(), { action: 'approve' }],
      })
    );
    expect(result.status).toBe('SUCCESS');
    expect(notified.filter((n) => n === 'firstSignoff')).toHaveLength(2);
    expect(fixSummaries).toEqual([CHANGES]);
  });

  it('fails the run on the third change request', async () => {
    const { fixSummaries, result } = await runTemplate(FOUR_EYES_SPEC, {
      ciPipelineSignal: [{ passed: true }, { passed: true }, { passed: true }],
      hitl_firstSignoff: [changes(), changes(), changes()],
    });
    expect(result.status).toBe('FAILED');
    expect(fixSummaries).toHaveLength(2);
  });

  it('fails the run on reject', async () => {
    const { result } = await runTemplate(FOUR_EYES_SPEC, {
      ...ciGreen(),
      hitl_firstSignoff: [{ action: 'reject' }],
    });
    expect(result.status).toBe('FAILED');
  });
});
