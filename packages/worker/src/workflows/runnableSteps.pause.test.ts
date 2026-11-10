import { beforeEach, describe, expect, it, vi } from 'vitest';

const fns = vi.hoisted(() => ({
  executeCIFixImplementation: vi.fn(async (..._args: unknown[]) => ({})),
  executeGateFixImplementation: vi.fn(async (..._args: unknown[]) => ({})),
  executeImplementation: vi.fn(async (..._args: unknown[]) => ({})),
  executeReviewFixImplementation: vi.fn(async (..._args: unknown[]) => ({})),
  runAgentNode: vi.fn(async (..._args: unknown[]) => ({})),
  runAgentNodeWorkspace: vi.fn(async (..._args: unknown[]) => ({})),
  runAgentTask: vi.fn(async (..._args: unknown[]) => ({})),
}));

vi.mock('./runnableActivities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runnableActivities.js')>();
  return {
    ...actual,
    agentActivities: {
      ...actual.agentActivities,
      executeCIFixImplementation: fns.executeCIFixImplementation,
      executeGateFixImplementation: fns.executeGateFixImplementation,
      executeImplementation: fns.executeImplementation,
      executeReviewFixImplementation: fns.executeReviewFixImplementation,
    },
    agentNodeActivities: { ...actual.agentNodeActivities, runAgentNode: fns.runAgentNode },
    agentNodeWorkspaceActivities: { runAgentNode: fns.runAgentNodeWorkspace },
    agentTaskActivities: { runAgentTask: fns.runAgentTask },
  };
});

const { dispatchStepImpl, isPausableStep } = await import('./runnableSteps.js');

const ctx = {
  context: { currentCodeResult: { branch: 'auto/T-1' } },
  workflow: { id: 'wf' },
} as never;
const request = { description: 'task', externalTicketId: 'T-1', repoId: 'r1' } as never;
const pause = { allowPause: true as const };
const resumed = {
  allowPause: true as const,
  resumeInput: { answers: [], resume: {} as never, round: 1 },
};
const dispatch = (step: string, config: Record<string, unknown>, p?: typeof pause) =>
  dispatchStepImpl(
    step,
    ctx,
    request,
    config,
    {
      failureContext: 'logs',
      gateOutput: { passed: false, summary: 's' },
      previousCodeResult: { branch: 'b' },
    },
    'k',
    p
  );

beforeEach(() => {
  for (const fn of Object.values(fns)) {
    fn.mockClear();
  }
});

describe('isPausableStep', () => {
  it.each([
    ['executeImplementation', {}, true],
    ['executeCIFixImplementation', {}, true],
    ['executeReviewFixImplementation', {}, true],
    ['executeGateFixImplementation', {}, true],
    ['runAgentTask', {}, true],
    ['runAgentNode', { workspace: true }, true],
    ['runAgentNode', {}, false],
    ['runAgentNode', { workspace: false }, false],
    ['resolveMergeConflict', {}, false],
    ['executePrFeedbackImplementation', {}, false],
    ['runReviewNetwork', {}, false],
    ['runLint', {}, false],
  ])('%s %j -> %s', (step, config, expected) => {
    expect(isPausableStep(step, config)).toBe(expected);
  });
});

describe('a dispatch without the ask-and-resume loop', () => {
  it('calls each activity exactly as before: no pause field anywhere', async () => {
    await dispatch('executeImplementation', {});
    await dispatch('executeCIFixImplementation', {});
    await dispatch('executeReviewFixImplementation', {});
    await dispatch('executeGateFixImplementation', {});
    await dispatch('runAgentTask', {});
    await dispatch('runAgentNode', { agentRef: 'a', workspace: true });
    // executeImplementation: (request, subtask, systemPrompt, crossRepo) only.
    expect(fns.executeImplementation.mock.calls[0]).toHaveLength(4);
    expect(fns.executeCIFixImplementation.mock.calls[0]).toHaveLength(3);
    expect(fns.executeReviewFixImplementation.mock.calls[0]).toHaveLength(3);
    expect(JSON.stringify(fns.executeGateFixImplementation.mock.calls[0])).not.toContain(
      'allowPause'
    );
    expect(fns.runAgentTask.mock.calls[0]).toEqual([{ request }]);
    expect(JSON.stringify(fns.runAgentNodeWorkspace.mock.calls[0])).not.toContain('allowPause');
  });
});

describe('a dispatch inside the loop', () => {
  it('passes executeImplementation the pause as its ninth argument', async () => {
    await dispatch('executeImplementation', {}, resumed);
    const args = fns.executeImplementation.mock.calls[0] as unknown[];
    expect(args).toHaveLength(9);
    expect(args.slice(4, 8)).toEqual([undefined, undefined, undefined, undefined]);
    expect(args[8]).toBe(resumed);
  });

  it('keeps the guard options and the allowed paths beside the pause', async () => {
    await dispatch(
      'executeImplementation',
      { allowedPaths: ['a'], refuseWorkflowChanges: true },
      pause
    );
    expect((fns.executeImplementation.mock.calls[0] as unknown[]).slice(4)).toEqual([
      ['a'],
      { refuseWorkflowChanges: true },
      undefined,
      undefined,
      pause,
    ]);
    await dispatch('executeReviewFixImplementation', { refuseWorkflowChanges: true }, resumed);
    expect((fns.executeReviewFixImplementation.mock.calls[0] as unknown[]).slice(3)).toEqual([
      undefined,
      { refuseWorkflowChanges: true, ...resumed },
    ]);
    await dispatch('executeCIFixImplementation', { untrustedCiLogs: true }, pause);
    expect((fns.executeCIFixImplementation.mock.calls[0] as unknown[])[3]).toEqual({
      untrustedCiLogs: true,
      ...pause,
    });
  });

  it('adds the pause to the options object of the fix sessions without a guard', async () => {
    await dispatch('executeCIFixImplementation', {}, pause);
    await dispatch('executeReviewFixImplementation', {}, pause);
    expect((fns.executeCIFixImplementation.mock.calls[0] as unknown[])[3]).toEqual(pause);
    expect((fns.executeReviewFixImplementation.mock.calls[0] as unknown[])[4]).toEqual(pause);
  });

  it('adds the pause to the gate fix, the agent run and a workspace agent node', async () => {
    await dispatch('executeGateFixImplementation', {}, resumed);
    expect(fns.executeGateFixImplementation.mock.calls[0]?.[0]).toMatchObject(resumed);
    await dispatch('runAgentTask', {}, pause);
    expect(fns.runAgentTask.mock.calls[0]).toEqual([{ allowPause: true, request }]);
    await dispatch('runAgentNode', { agentRef: 'a', workspace: true }, resumed);
    expect(fns.runAgentNodeWorkspace.mock.calls[0]?.[0]).toMatchObject(resumed);
  });
});
