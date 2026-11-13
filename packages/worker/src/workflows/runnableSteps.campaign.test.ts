import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  ci: vi.fn(),
  gate: vi.fn(),
  gateFix: vi.fn(),
  implement: vi.fn(),
  recipe: vi.fn(),
  review: vi.fn(),
}));
vi.mock('./runnableActivities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runnableActivities.js')>();
  return {
    ...actual,
    agentActivities: {
      ...actual.agentActivities,
      executeCIFixImplementation: calls.ci,
      executeGateFixImplementation: calls.gateFix,
      executeImplementation: calls.implement,
      executeReviewFixImplementation: calls.review,
    },
    gateActivities: { runTests: calls.gate },
    recipeActivities: { applyRecipe: calls.recipe },
  };
});
const { dispatchStepImpl } = await import('./runnableSteps.js');
beforeEach(() => vi.clearAllMocks());

const request = { description: 'task', externalTicketId: 'T-1', repoId: 'repo' } as never;
const code = { branch: 'auto/T-1', repoId: 'repo' };
const ctx = { context: { currentCodeResult: code } } as never;
const run = (step: string, config: Record<string, unknown>, inputs: Record<string, unknown> = {}) =>
  dispatchStepImpl(step, ctx, request, config, inputs, 'node');

describe('protectTests on a gate step', () => {
  it('passes the change’s recorded shas when the step sets protectTests to true', async () => {
    const recorded = {
      ...code,
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
    };
    await dispatchStepImpl(
      'runTests',
      { context: { currentCodeResult: recorded } } as never,
      request,
      { protectTests: true },
      {},
      'node'
    );
    expect(calls.gate.mock.calls[0]?.[0]).toMatchObject({
      protectTests: { baseSha: '1'.repeat(40), headSha: '2'.repeat(40) },
    });
  });

  it('passes an empty target when the code result recorded no base, so the gate fails closed', async () => {
    await run('runTests', { protectTests: true });
    expect(calls.gate.mock.calls[0]?.[0]).toMatchObject({ protectTests: {} });
  });

  it.each([undefined, false, 'true', 1])(
    'leaves the activity input byte-identical to before for protectTests=%j',
    async (value) => {
      await run('runTests', value === undefined ? {} : { protectTests: value });
      const input = calls.gate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.keys(input)).not.toContain('protectTests');
      expect(Object.keys(input).sort()).toEqual(['branch', 'command', 'request', 'timeoutMs']);
    }
  );

  it('still points the gate at the change’s own branch', async () => {
    await run('runTests', { protectTests: true });
    expect(calls.gate.mock.calls[0]?.[0]).toMatchObject({ branch: 'auto/T-1' });
  });
});

describe('testIntegrity floor on the agent steps', () => {
  it('hands the implementer a block floor in its guard options', async () => {
    await run('executeImplementation', { testIntegrity: 'block' });
    expect(calls.implement.mock.calls[0]?.[5]).toEqual({ testIntegrityFloor: 'block' });
  });

  it('hands the gate-fix session the floor, and does not invent a workflow refusal', async () => {
    await run(
      'executeGateFixImplementation',
      { testIntegrity: 'block' },
      { gateName: 'runTests', gateOutput: { passed: false, summary: 'x' } }
    );
    const input = calls.gateFix.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.testIntegrityFloor).toBe('block');
    expect(Object.keys(input)).not.toContain('refuseWorkflowChanges');
  });

  it('adds nothing for a step that sets no floor (or a value that is not one)', async () => {
    for (const config of [{}, { testIntegrity: 'nope' }, { testIntegrity: false }]) {
      calls.implement.mockClear();
      calls.gateFix.mockClear();
      await run('executeImplementation', config);
      await run('executeGateFixImplementation', config, {
        gateName: 'runTests',
        gateOutput: { passed: false, summary: 'x' },
      });
      expect(calls.implement.mock.calls[0]?.[5]).toBeUndefined();
      expect(Object.keys(calls.gateFix.mock.calls[0]?.[0] as object)).not.toContain(
        'testIntegrityFloor'
      );
    }
  });

  it('keeps a floor beside the options a step already sets', async () => {
    await run('executeImplementation', {
      knowledgeBases: true,
      refuseWorkflowChanges: true,
      testIntegrity: 'block',
    });
    expect(calls.implement.mock.calls[0]?.[5]).toEqual({
      knowledgeBases: true,
      refuseWorkflowChanges: true,
      testIntegrityFloor: 'block',
    });
  });
});

describe('applyRecipe', () => {
  it('binds the recipe and its two parameters from the step inputs', async () => {
    await run(
      'applyRecipe',
      {},
      { packageName: 'lodash', recipe: 'npm-dependency@1', targetVersion: '4.17.21' }
    );
    expect(calls.recipe).toHaveBeenCalledWith({
      params: { packageName: 'lodash', targetVersion: '4.17.21' },
      recipe: 'npm-dependency@1',
      request,
    });
  });

  it('passes nothing for a recipe the campaign did not name', async () => {
    await run('applyRecipe', {}, { packageName: '', recipe: '', targetVersion: '' });
    const input = calls.recipe.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(input)).not.toContain('recipe');
  });

  it('falls back to the step config for the recipe name', async () => {
    await run(
      'applyRecipe',
      { recipe: 'go-module@1' },
      { packageName: 'a.b/c', targetVersion: 'v1.0.0' }
    );
    expect(calls.recipe.mock.calls[0]?.[0]).toMatchObject({ recipe: 'go-module@1' });
  });

  it('forwards the text as given: validation is the activity’s job, not the executor’s', async () => {
    await run(
      'applyRecipe',
      {},
      { packageName: '$(touch pwned)', recipe: 'npm-dependency@1', targetVersion: '1;2' }
    );
    expect(calls.recipe.mock.calls[0]?.[0]).toMatchObject({
      params: { packageName: '$(touch pwned)', targetVersion: '1;2' },
    });
  });
});
