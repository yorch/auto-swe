import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  agentPr: vi.fn(),
  ci: vi.fn(),
  conflict: vi.fn(),
  gate: vi.fn(),
  implement: vi.fn(),
  node: vi.fn(),
  plan: vi.fn(),
  pr: vi.fn(),
  retrieve: vi.fn(),
  review: vi.fn(),
  task: vi.fn(),
}));
vi.mock('./runnableActivities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runnableActivities.js')>();
  return {
    ...actual,
    agentActivities: {
      ...actual.agentActivities,
      executeCIFixImplementation: calls.ci,
      executeGateFixImplementation: calls.gate,
      executeImplementation: calls.implement,
      executePrFeedbackImplementation: calls.pr,
      executeReviewFixImplementation: calls.review,
      planDecomposition: calls.plan,
    },
    agentNodeWorkspaceActivities: { runAgentNode: calls.node },
    agentTaskActivities: { runAgentTask: calls.task },
    conflictActivities: { resolveMergeConflict: calls.conflict },
    knowledgeActivities: { retrieveKnowledge: calls.retrieve },
    prFeedbackAgentTaskActivities: { runAgentPrFeedbackTask: calls.agentPr },
  };
});
const { dispatchStepImpl } = await import('./runnableSteps.js');
beforeEach(() => vi.clearAllMocks());
const request = { description: 'task', externalTicketId: 'T-1', repoId: 'repo' } as never;

describe('workspace agent knowledge base step flags', () => {
  it.each([false, true])(
    'threads an explicit %s flag to every workspace agent activity',
    async (enabled) => {
      const code = { branch: 'auto/T-1', repoId: 'repo' };
      const inputs = {
        gateOutput: { passed: false, summary: 'failure' },
        gather: { brief: 'feedback', codeResult: code },
        previousCodeResult: code,
        sourceBranches: ['feature'],
        targetBranch: 'main',
      };
      const config = { agentRef: 'reviewer', knowledgeBases: enabled, workspace: true };
      for (const step of [
        'executeImplementation',
        'executeCIFixImplementation',
        'executeReviewFixImplementation',
        'executeGateFixImplementation',
        'runAgentNode',
        'runAgentTask',
        'resolveMergeConflict',
        'executePrFeedbackImplementation',
        'runAgentPrFeedbackTask',
        'retrieveKnowledge',
        'planDecomposition',
      ]) {
        await dispatchStepImpl(
          step,
          { context: { currentCodeResult: code } } as never,
          request,
          config,
          inputs,
          'node'
        );
      }
      expect(calls.implement.mock.calls[0][3]).toMatchObject({ knowledgeBases: enabled });
      expect(calls.ci.mock.calls[0][3]).toMatchObject({ knowledgeBases: enabled });
      expect(calls.review.mock.calls[0][4]).toMatchObject({ knowledgeBases: enabled });
      expect(calls.pr.mock.calls[0][0].options).toMatchObject({ knowledgeBases: enabled });
      expect(calls.plan).toHaveBeenCalledWith(request, undefined, enabled);
      for (const fn of [
        calls.gate,
        calls.node,
        calls.task,
        calls.conflict,
        calls.agentPr,
        calls.retrieve,
      ]) {
        expect(fn.mock.calls[0][0]).toMatchObject({ knowledgeBases: enabled });
      }
    }
  );

  it('does not send an opt-out when the step is unconfigured', async () => {
    await dispatchStepImpl('executeImplementation', {} as never, request, {}, {}, 'node');
    expect(calls.implement.mock.calls[0][3]).not.toHaveProperty('knowledgeBases');
  });
});
