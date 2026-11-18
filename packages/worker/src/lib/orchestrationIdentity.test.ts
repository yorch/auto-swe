import { ApplicationFailure } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  info: undefined as { workflowExecution?: { workflowId: string } } | undefined,
}));
vi.mock('@temporalio/activity', async (orig) => ({
  ...(await orig<typeof import('@temporalio/activity')>()),
  activityInfo: () => {
    if (!ctx.info) {
      throw new Error('Activity context not initialized');
    }
    return ctx.info;
  },
}));

import {
  assertCurrentWorkflowOwns,
  assertOwnWorkflowId,
  ORCHESTRATION_WORKFLOW_MISMATCH,
} from './orchestrationIdentity.js';

const ORCH = '0b1c2d3e-0000-4000-8000-000000000001';
const OTHER = '0b1c2d3e-0000-4000-8000-000000000002';

beforeEach(() => {
  ctx.info = undefined;
});

describe('assertOwnWorkflowId', () => {
  it('accepts the workflow id the orchestration owns', () => {
    expect(() => assertOwnWorkflowId(ORCH, `orch-${ORCH}`)).not.toThrow();
  });

  it.each([
    ['another orchestration', `orch-${OTHER}`],
    ['a free-form id', 'my-own-workflow'],
    ['a replay fixture id', 'replay-fixture-linear'],
    ['a prefix of the id', `orch-${ORCH}-2`],
    ['empty', ''],
  ])('refuses %s, non-retryably', (_name, workflowId) => {
    let thrown: unknown;
    try {
      assertOwnWorkflowId(ORCH, workflowId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect((thrown as ApplicationFailure).type).toBe(ORCHESTRATION_WORKFLOW_MISMATCH);
  });
});

describe('assertCurrentWorkflowOwns', () => {
  it('judges the workflow that scheduled the running activity', () => {
    ctx.info = { workflowExecution: { workflowId: `orch-${ORCH}` } };
    expect(() => assertCurrentWorkflowOwns(ORCH)).not.toThrow();
    expect(() => assertCurrentWorkflowOwns(OTHER)).toThrow(/does not own|not the one/);
  });

  it('refuses an activity context that names no workflow', () => {
    ctx.info = {};
    expect(() => assertCurrentWorkflowOwns(ORCH)).toThrow();
  });

  it('checks nothing outside an activity (a unit test calling the function directly)', () => {
    expect(() => assertCurrentWorkflowOwns(ORCH)).not.toThrow();
  });
});
