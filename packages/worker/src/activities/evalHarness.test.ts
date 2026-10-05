import { ApplicationFailure } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks for the runCaseDefault path — its collaborators are the Docker + LLM
// boundary. The runEvalHarness tests below inject their own deps and never
// exercise these, so mocking them here is inert for those tests.
const generate = vi.fn(async () => ({}));
const execCapture = vi.fn(async () => ({ exitCode: 1, stderr: 'fail', stdout: '' }));
const destroy = vi.fn(async () => {});

vi.mock('./workspace.js', () => ({
  createWorkspace: vi.fn(async () => ({ destroy, execCapture })),
}));
vi.mock('../agents/implementer.js', () => ({
  createImplementerAgent: vi.fn(async () => ({
    agent: { generate },
    closeMcp: undefined,
    promptSuffix: '',
  })),
}));
vi.mock('../lib/config/agentResolver.js', () => ({
  resolveAgent: vi.fn(async () => ({
    model: { apiBase: undefined, apiKey: 'k', spec: 'anthropic/x', systemPrompt: undefined },
    skills: [],
    toolKeys: null,
  })),
}));
vi.mock('../lib/config/mcpConnection.js', () => ({
  resolveAgentMcpUrl: vi.fn(async () => undefined),
}));
vi.mock('../lib/models.js', () => ({ resolveModel: vi.fn(() => ({})) }));
const persistActivityTrace = vi.fn(async () => {});
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: vi.fn(() => 'eval-wf-1'),
  persistActivityTrace: (...args: unknown[]) => persistActivityTrace(...(args as [])),
}));
const assertBudgetAvailable = vi.fn(async () => {});
const recordLlmUsage = vi.fn(async () => ({
  costUsd: 0.01,
  inputTokens: 10,
  modelSpec: 'anthropic/x',
  outputTokens: 5,
}));
vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: (...args: unknown[]) => assertBudgetAvailable(...(args as [])),
  recordLlmUsage: (...args: unknown[]) => recordLlmUsage(...(args as [])),
}));
vi.mock('../lib/llmOutputScan.js', () => ({ recordSuspiciousLlmOutput: vi.fn(async () => {}) }));
const evalRunUpdateMany = vi.fn();
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { evalRun: { updateMany: (...a: unknown[]) => evalRunUpdateMany(...(a as [])) } },
}));
const recordRunFinalized = vi.fn();
vi.mock('../lib/metrics.js', () => ({
  recordRunFinalized: (...a: unknown[]) => recordRunFinalized(...(a as [])),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ maxEvalIterations: 3 })),
}));
// The harness resolves the implementer's tool-output budget the same way it
// resolves the model; without this the registry resolver reaches for Prisma.
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async () => 'mastra'),
  resolveSettings: vi.fn(async () => ({
    'workspace.agentMaxSteps': 64,
    'workspace.maxToolOutputChars': 20_000,
  })),
}));

import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { createImplementerAgent } from '../agents/implementer.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import {
  _defaults,
  type EvalCaseRow,
  type HarnessDeps,
  runCaseDefault,
  runEvalHarness,
} from './evalHarness.js';

const cases: EvalCaseRow[] = [
  {
    baselineSha: 's1',
    goldenTest: 'yarn test',
    id: 'c1',
    input: { description: 'x' },
    repoUrl: 'r1',
    tags: ['repo:a'],
  },
  {
    baselineSha: 's2',
    goldenTest: 'yarn test',
    id: 'c2',
    input: { description: 'x' },
    repoUrl: 'r2',
    tags: ['repo:a'],
  },
  {
    baselineSha: 's3',
    goldenTest: 'yarn test',
    id: 'c3',
    input: { description: 'x' },
    repoUrl: 'r3',
    tags: ['repo:b'],
  },
];

function deps(over: Partial<HarnessDeps> = {}): HarnessDeps & {
  records: unknown[];
  finals: { status: string; summary: unknown }[];
} {
  const records: unknown[] = [];
  const finals: { status: string; summary: unknown }[] = [];
  return {
    finalize: async (_id, status, summary) => {
      finals.push({ status, summary });
    },
    finals,
    loadCases: async () => cases,
    record: (async (r: unknown) => {
      records.push(r);
    }) as HarnessDeps['record'],
    records,
    runCase: async () => 1,
    ...over,
  };
}

const input = {
  baselineRef: 'main',
  candidateRef: 'cand',
  datasetId: 'd1',
  evalRunId: 'run-1',
};

describe('defaultFinalize', () => {
  beforeEach(() => {
    evalRunUpdateMany.mockReset();
    recordRunFinalized.mockReset();
  });

  it('finalizes only a run that has not ended, and counts the verdict once', async () => {
    evalRunUpdateMany.mockResolvedValue({ count: 1 });

    await _defaults.defaultFinalize('run-1', 'REGRESSION', { overall: 1 });

    expect(evalRunUpdateMany).toHaveBeenCalledWith({
      data: { endedAt: expect.any(Date), status: 'REGRESSION', summary: { overall: 1 } },
      where: { endedAt: null, id: 'run-1' },
    });
    expect(recordRunFinalized).toHaveBeenCalledExactlyOnceWith('REGRESSION', 'eval');
  });

  it('counts nothing when the run had already ended or the write failed', async () => {
    evalRunUpdateMany.mockResolvedValueOnce({ count: 0 });
    await _defaults.defaultFinalize('run-1', 'FAILED', {});
    evalRunUpdateMany.mockRejectedValueOnce(new Error('db down'));
    await _defaults.defaultFinalize('run-1', 'FAILED', {});

    expect(recordRunFinalized).not.toHaveBeenCalled();
  });
});

describe('runEvalHarness', () => {
  it('records one gate row per case (candidate arm) and finalizes', async () => {
    const d = deps();
    await runEvalHarness(input, d);
    expect(d.records).toHaveLength(3);
    expect(d.finals).toHaveLength(1);
    expect(d.finals[0].status).toBe('SUCCESS');
  });

  it('marks REGRESSION when the candidate is consistently worse', async () => {
    // baseline passes everything, candidate fails everything
    const d = deps({
      runCase: vi.fn(async (_c, ref) => (ref === 'main' ? 1 : 0)) as HarnessDeps['runCase'],
    });
    const verdict = await runEvalHarness(input, d);
    expect(verdict.regression).toBe(true);
    expect(d.finals[0].status).toBe('REGRESSION');
  });

  it('does not flag REGRESSION when arms are equal', async () => {
    const d = deps({ runCase: async () => 1 });
    const verdict = await runEvalHarness(input, d);
    expect(verdict.regression).toBe(false);
    expect(verdict.overall.delta).toBe(0);
  });

  it('persists the candidate floor outcome (value 0 on failure)', async () => {
    const d = deps({
      runCase: async (_c, ref) => (ref === 'cand' ? 0 : 1),
    });
    await runEvalHarness(input, d);
    expect((d.records[0] as { value: number }).value).toBe(0);
    expect((d.records[0] as { passed: boolean }).passed).toBe(false);
  });

  const budgetStop = () =>
    ApplicationFailure.nonRetryable('Runless workflow budget exceeded', 'BUDGET_EXCEEDED');

  it('finishes over the completed cases, marked partial, when the budget stops it part-way', async () => {
    const d = deps({
      // c1 completes; the candidate arm of c2 runs out of budget.
      runCase: vi.fn(async (c: EvalCaseRow, ref: string) => {
        if (c.id !== 'c1' && ref === 'cand') {
          throw budgetStop();
        }
        return 1 as const;
      }) as HarnessDeps['runCase'],
    });

    const verdict = await runEvalHarness(input, d);

    expect(verdict.overall.n).toBe(1);
    expect(d.records).toHaveLength(1);
    expect(d.finals).toHaveLength(1);
    expect(d.finals[0].status).toBe('SUCCESS');
    expect(d.finals[0].summary).toMatchObject({
      overall: { n: 1 },
      partial: {
        completedCases: 1,
        error: 'Runless workflow budget exceeded',
        notRunCaseIds: ['c2', 'c3'],
        reason: 'budget',
        totalCases: 3,
      },
    });
    // Stops at the breach: nothing runs after c2.
    expect(vi.mocked(d.runCase).mock.calls.map(([c]) => c.id)).toEqual(['c1', 'c1', 'c2', 'c2']);
  });

  it('marks the partial org_budget when the organization cap, not the runless cap, stopped it', async () => {
    const d = deps({
      runCase: vi.fn(async (c: EvalCaseRow, ref: string) => {
        if (c.id !== 'c1' && ref === 'cand') {
          throw ApplicationFailure.nonRetryable(
            'Organization monthly budget exhausted',
            'BUDGET_EXCEEDED',
            {
              cap: 'organization',
            }
          );
        }
        return 1 as const;
      }) as HarnessDeps['runCase'],
    });
    await runEvalHarness(input, d);
    expect(d.finals[0].summary).toMatchObject({
      partial: { completedCases: 1, reason: 'org_budget' },
    });
  });

  it('fails when the budget stops it before any case completed', async () => {
    const d = deps({
      runCase: async () => {
        throw budgetStop();
      },
    });
    await expect(runEvalHarness(input, d)).rejects.toMatchObject({ type: 'BUDGET_EXCEEDED' });
    expect(d.finals).toHaveLength(0);
  });

  it('still fails on an infrastructure error, even beside a budget stop', async () => {
    const d = deps({
      runCase: vi.fn(async (c: EvalCaseRow, ref: string) => {
        if (c.id === 'c2') {
          throw ref === 'cand' ? budgetStop() : new Error('docker down');
        }
        return 1 as const;
      }) as HarnessDeps['runCase'],
    });
    await expect(runEvalHarness(input, d)).rejects.toThrow('docker down');
    expect(d.finals).toHaveLength(0);
  });

  it('carries no partial marker on a run that completed every case', async () => {
    const d = deps();
    await runEvalHarness(input, d);
    expect(d.finals[0].summary).not.toHaveProperty('partial');
  });
});

describe('runCaseDefault iteration cap', () => {
  beforeEach(() => {
    generate.mockClear();
    execCapture.mockClear();
    execCapture.mockResolvedValue({ exitCode: 1, stderr: 'fail', stdout: '' });
    persistActivityTrace.mockClear();
    assertBudgetAvailable.mockClear();
    recordLlmUsage.mockClear();
  });

  it('traces and bills every implementer call and persists the trace', async () => {
    generate.mockResolvedValue({ text: 'done', usage: { inputTokens: 10, outputTokens: 5 } });
    vi.mocked(resolveWorkflowDefaults).mockResolvedValueOnce({ maxEvalIterations: 2 } as never);

    await runCaseDefault(cases[0], 'implementer@3');

    expect(assertBudgetAvailable).toHaveBeenCalledTimes(2);
    expect(recordLlmUsage).toHaveBeenCalledTimes(2);
    expect(recordLlmUsage).toHaveBeenCalledWith(
      'eval-wf-1',
      'implementer',
      { inputTokens: 10, outputTokens: 5 },
      'llm.eval.implementer.iteration_0',
      'anthropic/x'
    );
    expect(persistActivityTrace).toHaveBeenCalledWith(expect.anything(), 'implementer');
  });

  it('passes the resolved step budget to every generate call', async () => {
    generate.mockResolvedValue({ text: 'done', usage: { inputTokens: 10, outputTokens: 5 } });
    vi.mocked(resolveWorkflowDefaults).mockResolvedValueOnce({ maxEvalIterations: 1 } as never);

    await runCaseDefault(cases[0], 'implementer');

    expect((generate.mock.calls[0] as unknown[])[1]).toMatchObject({ maxSteps: 64 });
  });

  it('hands the connection headers and private-network opt-in to the implementer', async () => {
    generate.mockResolvedValue({ text: 'done', usage: { inputTokens: 10, outputTokens: 5 } });
    vi.mocked(resolveWorkflowDefaults).mockResolvedValueOnce({ maxEvalIterations: 1 } as never);
    const headers = [{ name: 'x-tenant', value: 'acme' }];
    vi.mocked(resolveAgentMcpUrl).mockResolvedValueOnce({
      allowPrivateNetwork: true,
      bearerToken: 'tok',
      headers,
      url: 'http://10.0.0.5/mcp',
    } as never);

    await runCaseDefault(cases[0], 'implementer');

    const options = vi.mocked(createImplementerAgent).mock.calls.at(-1)?.[4];
    expect(options).toMatchObject({
      mcpAllowPrivateNetwork: true,
      mcpBearerToken: 'tok',
      mcpHeaders: headers,
      mcpServerRef: 'http://10.0.0.5/mcp',
    });
  });

  it('persists the trace even when the agent throws', async () => {
    generate.mockRejectedValueOnce(new Error('LLM exploded'));
    await expect(runCaseDefault(cases[0], 'implementer')).rejects.toThrow('LLM exploded');
    expect(persistActivityTrace).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalled();
  });

  it('runs at most maxEvalIterations refine attempts before scoring 0', async () => {
    vi.mocked(resolveWorkflowDefaults).mockResolvedValueOnce({ maxEvalIterations: 2 } as never);

    const result = await runCaseDefault(cases[0], 'implementer');

    // Golden test never passes → loop is bounded by the resolved cap, not 3.
    expect(result).toBe(0);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(execCapture).toHaveBeenCalledTimes(2);
  });

  it('returns 1 as soon as the golden test passes, short-circuiting the cap', async () => {
    vi.mocked(resolveWorkflowDefaults).mockResolvedValueOnce({ maxEvalIterations: 3 } as never);
    execCapture.mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: 'ok' });

    const result = await runCaseDefault(cases[0], 'implementer');

    expect(result).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
