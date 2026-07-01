/**
 * Integration coverage for NL workflow authoring: prove that a spec produced by
 * the generate→validate→repair loop is not just schema-valid but actually
 * EXECUTABLE — by running it through the real shared interpreter (`runSpec`) with
 * a fake dispatcher. This is the closest we can get to an end-to-end check
 * without standing up Postgres/Temporal (see docs/verify-nl-authoring.md for the
 * full manual runbook against live infra).
 */

import { type Context, type Dispatcher, runSpec } from '@auto-swe/shared/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agent: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ description: null, key: 'implementer', name: 'Implementer' }]),
    },
    connection: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn().mockResolvedValue({ agentKey: 'workflowAuthor' }),
}));
vi.mock('./runAgent.js', () => ({ runAgent: vi.fn() }));

import { generateWorkflowSpec } from './generateWorkflowSpec.js';
import { runAgent } from './runAgent.js';

const mockedRunAgent = vi.mocked(runAgent);

// A representative SWE workflow the author agent would plausibly emit.
const GENERATED_SPEC = {
  description: 'Implement a ticket and open a PR after review.',
  entry: 'validate',
  name: 'Implement & PR',
  nodes: {
    done: { status: 'SUCCESS', type: 'terminate' },
    fail: { status: 'FAILED', type: 'terminate' },
    gate: {
      expr: 'nodes.review.output.approved == true',
      onFalse: 'fail',
      onTrue: 'pr',
      type: 'cond',
    },
    implement: { next: 'review', step: 'executeImplementation', type: 'step' },
    pr: { next: 'done', step: 'createOrUpdatePullRequest', type: 'step' },
    review: { next: 'gate', step: 'runReviewNetwork', type: 'step' },
    validate: { next: 'implement', step: 'validateContext', type: 'step' },
  },
  schemaVersion: 1,
};

const baseCtx = (): Context => ({
  context: {},
  nodes: {},
  request: { externalTicketId: 'TEST-1', repoId: 'repo-1' },
  workflow: { id: 'eng-test-1' },
});

beforeEach(() => vi.clearAllMocks());

describe('NL authoring → interpreter integration', () => {
  it('generates a spec that the interpreter can execute to SUCCESS', async () => {
    mockedRunAgent.mockResolvedValue({
      object: { specJson: JSON.stringify(GENERATED_SPEC), summary: 'impl + PR' },
    });

    // 1. Generate + validate (the real activity loop).
    const { spec } = await generateWorkflowSpec({
      prompt: 'implement and open a PR',
      teamId: 't1',
    });
    expect(spec.entry).toBe('validate');

    // 2. Execute the generated graph through the real interpreter with canned
    //    step outputs (the review approves, so the cond takes the PR branch).
    const calls: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatchStep({ step }) {
        calls.push(step);
        return step === 'runReviewNetwork' ? { approved: true } : { ok: true };
      },
      async recordStep() {},
      async waitSignal() {
        return undefined;
      },
    };

    const result = await runSpec(spec, baseCtx(), dispatcher);

    expect(result.status).toBe('SUCCESS');
    expect(calls).toEqual([
      'validateContext',
      'executeImplementation',
      'runReviewNetwork',
      'createOrUpdatePullRequest',
    ]);
  });

  it('routes to the FAILED terminal when the generated cond branch is false', async () => {
    mockedRunAgent.mockResolvedValue({
      object: { specJson: JSON.stringify(GENERATED_SPEC), summary: 'impl + PR' },
    });
    const { spec } = await generateWorkflowSpec({ prompt: 'x', teamId: 't1' });

    const dispatcher: Dispatcher = {
      async dispatchStep({ step }) {
        return step === 'runReviewNetwork' ? { approved: false } : { ok: true };
      },
      async recordStep() {},
      async waitSignal() {
        return undefined;
      },
    };

    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('FAILED');
  });
});
