import { ApplicationFailure } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  agentWs: {
    containerId: 'agent-ws',
    destroy: vi.fn(async () => {}),
    exec: vi.fn(async () => 'base-sha\n'),
    execCapture: vi.fn(async () => ({
      exitCode: 0,
      stderr: '',
      stdout: 'diff --git a/x b/x\n+x\n',
    })),
    gitAuthed: vi.fn(async () => ''),
  },
  assertBudget: vi.fn(async (_label?: string) => {}),
  claudeCodeRuntime: vi.fn(),
  closeRows: vi.fn(async (_args: unknown) => ({ count: 1 })),
  commit: vi.fn(),
  createPr: vi.fn(),
  gate: vi.fn(),
  harnessTurn: vi.fn(),
  importTree: vi.fn(async () => 10),
  ledger: { id: 'ledger-1', repoId: 'repo-1' } as unknown,
  mcpConnectionId: null as string | null,
  modelSpec: 'anthropic/x',
  persist: vi.fn(async (_tracer: unknown, _key: string) => {}),
  prCreate: vi.fn(async (_args: unknown) => ({})),
  prUpdate: vi.fn(async (_args: unknown) => ({})),
  push: vi.fn(),
  recordUsage: vi.fn(),
  resolveAgentSpec: vi.fn(),
  run: {
    template: { name: 'Agent Run', origin: 'system:agent-run', teamId: null },
    templateId: 'tpl-1',
  } as unknown,
  runAgent: vi.fn(),
  runtime: null as string | null,
  settings: {
    'workspace.agentRunAllowWorkflowChanges': false,
    'workspace.agentRunMaxConcurrentGlobal': 4,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
    'workspace.agentRunMaxSteps': 50,
    'workspace.agentRunMaxWallClockSeconds': 1800,
    'workspace.maxToolOutputChars': 20000,
  } as Record<string, unknown>,
  slots: [] as Array<{ workflowId: string; teamId: string | null; launchedAt: Date }>,
  /** Per workflow id: `finished` or `down`; anything else is running. */
  temporal: {} as Record<string, 'finished' | 'down'>,
  toolKeys: null as string[] | null,
  trustedWs: {
    containerId: 'trusted-ws',
    destroy: vi.fn(async () => {}),
    gitAuthed: vi.fn(async () => ''),
  },
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findFirst: vi.fn(async () => m.ledger), updateMany: m.closeRows },
    connection: {
      findUniqueOrThrow: vi.fn(async () => ({
        defaultBranch: 'main',
        executorImage: null,
        id: 'repo-1',
        installation: null,
      })),
    },
    pullRequest: { create: m.prCreate, update: m.prUpdate },
    workflowRun: { findUnique: vi.fn(async () => m.run) },
  },
}));
vi.mock('../lib/temporalClient.js', () => ({
  getTemporalClient: () => ({
    workflow: {
      getHandle: (id: string) => ({
        describe: async () => {
          if (m.temporal[id] === 'down') {
            throw new Error('temporal unreachable');
          }
          return { status: { name: m.temporal[id] === 'finished' ? 'TERMINATED' : 'RUNNING' } };
        },
      }),
    },
  }),
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSettings: vi.fn(async () => m.settings) }));
vi.mock('@auto-swe/shared/lib/agentRunAdmission', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/agentRunAdmission')>()),
  loadAgentRunSlots: vi.fn(async () => m.slots),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: vi.fn(() => 'wf-1'),
  persistActivityTrace: m.persist,
}));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({
    agentVersions: { contentWriter: 3 },
    orgId: 'org-1',
    skillRevisions: { 'skill-1': 4 },
    teamId: 'team-1',
    workflowTemplateId: 'tpl-1',
  })),
}));
const { defaultResolveAgent } = vi.hoisted(() => ({
  defaultResolveAgent: async (key: string) => ({
    key,
    mcpConnectionId: m.mcpConnectionId,
    model: { apiBase: undefined, apiKey: 'k', spec: m.modelSpec, systemPrompt: null },
    runtime: m.runtime,
    skills: [],
    toolKeys: m.toolKeys,
    version: 3,
  }),
}));
vi.mock('../lib/config/agentResolver.js', () => ({
  resolveAgent: vi.fn(defaultResolveAgent),
}));
vi.mock('../agents/claudeCode/runtime.js', () => ({ claudeCodeRuntime: m.claudeCodeRuntime }));
vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: m.assertBudget,
  recordLlmUsage: m.recordUsage,
}));
vi.mock('../lib/llmOutputScan.js', () => ({ recordSuspiciousLlmOutput: vi.fn(async () => {}) }));
// The REAL resolveAgentSpec runs (it intersects the offered tools with the
// agent's toolKeys again), so the tool tests see what the agent is really given.
vi.mock('../lib/config/agentSpec.js', async (orig) => {
  const actual = await orig<typeof import('../lib/config/agentSpec.js')>();
  m.resolveAgentSpec.mockImplementation(actual.resolveAgentSpec);
  return { resolveAgentSpec: m.resolveAgentSpec };
});
vi.mock('../lib/models.js', () => ({ resolveModel: vi.fn(() => 'model') }));
vi.mock('../lib/config/mcpConnection.js', () => ({ resolveAgentMcpUrl: vi.fn(async () => null) }));
vi.mock('../agents/mcpTools.js', async (orig) => ({
  isMcpToolEnabled: (await orig<typeof import('../agents/mcpTools.js')>()).isMcpToolEnabled,
  loadMcpTools: vi.fn(),
}));
vi.mock('../agents/workspaceTools.js', () => ({
  buildWorkspaceTools: vi.fn(() => ({
    bash: 'B',
    listDirectory: 'L',
    readFile: 'R',
    writeFile: 'W',
  })),
}));
vi.mock('../lib/execUtils.js', () => ({
  throwIfActivityCancelled: vi.fn(),
  withHeartbeat: (_l: string, p: Promise<unknown>) => p,
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: vi.fn(() => ({
    cloneCredentials: async () => ({ authedCloneUrl: 'https://x-access-token:T@h/o/r.git' }),
    createOrUpdatePullRequest: m.createPr,
  })),
  toRepoRef: vi.fn(() => ({ organizationName: 'o', repoName: 'r' })),
}));
vi.mock('./workspace.js', () => ({
  createWorkspace: vi.fn(),
  shellQuote: (s: string) => `'${s}'`,
}));
vi.mock('./runAgent.js', () => ({ runAgent: m.runAgent }));
const { assertPricedMock } = vi.hoisted(() => ({ assertPricedMock: vi.fn(async () => {}) }));
vi.mock('../lib/usdCapGuard.js', () => ({ assertModelPricedForUsdCap: assertPricedMock }));
vi.mock('./agentRunFinalize.js', () => ({
  commitTrustedTree: m.commit,
  gateTrustedCommit: m.gate,
  importAgentTree: m.importTree,
  pushGatedCommit: m.push,
}));

import { __resetReconcileCacheForTests } from '@auto-swe/shared/lib/agentRunAdmission';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { DraftPullRequestUnsupportedError } from '../lib/scm/types.js';
import { runAgentTask } from './runAgentTask.js';
import { createWorkspace } from './workspace.js';

const request = (over: Record<string, unknown> = {}) =>
  ({
    description: 'fix the typo',
    externalTicketId: 'agent-0a1b2c3d111122223333444455556666',
    payload: { agentRef: 'contentWriter', deliver: 'none' },
    repoId: 'repo-1',
    requestPayload: '{}',
    ...over,
  }) as never;

const GATED = {
  baseSha: 'base-sha',
  codeSecurityFindings: [],
  diff: 'diff --git a/x b/x\n+x\n',
  filesChanged: [
    { language: 'ts', linesAdded: 1, linesRemoved: 0, operation: 'CREATE', path: 'x' },
  ],
  sha: 'f'.repeat(40),
  workspaceId: 'trusted-ws',
};

/** The activity events the run's tracer held when it was persisted. */
function traceEvents(): Array<{ error?: string; toolName: string }> {
  const tracer = m.persist.mock.calls[0]?.[0] as
    | { records: Array<{ error?: string; toolName: string }> }
    | undefined;
  return tracer ? tracer.records : [];
}

async function failureOf(p: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await p;
  } catch (e) {
    return e as ApplicationFailure;
  }
  throw new Error('expected a failure');
}

beforeEach(() => {
  __resetReconcileCacheForTests();
  vi.clearAllMocks();
  m.run = {
    template: { name: 'Agent Run', origin: 'system:agent-run', teamId: null },
    templateId: 'tpl-1',
  };
  m.ledger = { id: 'ledger-1', repoId: 'repo-1' };
  m.prCreate.mockResolvedValue({});
  m.slots = [{ launchedAt: new Date(1), teamId: 'team-1', workflowId: 'wf-1' }];
  m.temporal = {};
  m.toolKeys = null;
  // A test may replace the implementation; clearAllMocks does not restore it.
  vi.mocked(resolveAgent).mockImplementation(defaultResolveAgent as never);
  m.runtime = null;
  m.mcpConnectionId = null;
  m.modelSpec = 'anthropic/x';
  m.claudeCodeRuntime.mockImplementation(() => ({ runTurn: m.harnessTurn }));
  m.harnessTurn.mockResolvedValue({
    steps: 6,
    text: 'harness done',
    toolCallCount: 3,
    usageByModel: [{ modelSpec: 'anthropic/x', usage: { inputTokens: 10, outputTokens: 5 } }],
  });
  m.recordUsage.mockResolvedValue({
    costUsd: 0.25,
    inputTokens: 10,
    modelSpec: 'anthropic/x',
    outputTokens: 5,
  });
  m.settings['workspace.agentRunMaxConcurrentGlobal'] = 4;
  m.settings['workspace.agentRunMaxConcurrentPerTeam'] = 2;
  m.settings['workspace.agentRunMaxSteps'] = 50;
  m.settings['workspace.agentRunMaxWallClockSeconds'] = 1800;
  vi.mocked(createWorkspace)
    .mockReset()
    .mockResolvedValueOnce(m.agentWs as never)
    .mockResolvedValueOnce(m.trustedWs as never);
  m.agentWs.exec.mockResolvedValue('base-sha\n');
  m.runAgent.mockResolvedValue({ costUsd: 0.5, stepCount: 4, text: 'done' });
  m.commit.mockResolvedValue({ empty: false, sha: GATED.sha });
  m.gate.mockResolvedValue(GATED);
  m.push.mockResolvedValue(undefined);
  m.createPr.mockResolvedValue({ prNumber: 7, prUrl: 'https://x/pull/7' });
});

describe('authority checks (the worker does not trust the gateway)', () => {
  it('refuses to run for any template that is not the system template', async () => {
    for (const run of [
      { template: { name: 'Agent Run', origin: null, teamId: null }, templateId: 't' },
      { template: { name: 'Agent Run', origin: 'swe-starter', teamId: null }, templateId: 't' },
      { template: { name: 'My Run', origin: 'system:agent-run', teamId: null }, templateId: 't' },
      {
        template: { name: 'Agent Run', origin: 'system:agent-run', teamId: 'team' },
        templateId: 't',
      },
      null,
    ]) {
      m.run = run;
      const f = await failureOf(runAgentTask({ request: request() }));
      expect(f.type).toBe('AGENT_RUN_NOT_SYSTEM_TEMPLATE');
      expect(f.nonRetryable).toBe(true);
    }
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it('refuses a request whose repo is not the one the ledger row names', async () => {
    m.ledger = { repoId: 'someone-elses-repo' };
    expect((await failureOf(runAgentTask({ request: request() }))).type).toBe(
      'AGENT_RUN_REPO_MISMATCH'
    );
  });

  it.each([
    [{ agentRef: '' }],
    [{ agentRef: 'a', deliver: 'push' }],
    [undefined],
    [{ agentRef: 'a', maxSteps: 100000 }],
  ])('re-validates the payload: %j', async (payload) => {
    const f = await failureOf(runAgentTask({ request: request({ payload }) }));
    expect(f.type).toBe('AGENT_RUN_INVALID_PAYLOAD');
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it.each(['securityReview', 'evalJudge', 'workflowAuthor'])(
    'refuses the platform agent %s',
    async (key) => {
      const f = await failureOf(
        runAgentTask({ request: request({ payload: { agentRef: key, deliver: 'none' } }) })
      );
      expect(f.type).toBe('AGENT_NOT_LAUNCHABLE');
      expect(m.runAgent).not.toHaveBeenCalled();
    }
  );

  it('only publishes under its own agent-<id> branch names', async () => {
    const f = await failureOf(runAgentTask({ request: request({ externalTicketId: 'JIRA-1' }) }));
    expect(f.type).toBe('AGENT_RUN_INVALID_PAYLOAD');
  });
});

describe('concurrency and kill switch', () => {
  it('refuses when agent runs are disabled for the team (0)', async () => {
    m.settings['workspace.agentRunMaxConcurrentPerTeam'] = 0;
    expect((await failureOf(runAgentTask({ request: request() }))).type).toBe(
      'AGENT_RUNS_DISABLED'
    );
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('is admitted once a row whose workflow Temporal reports finished is closed', async () => {
    // A crashed older run holds the only per-team slot in the ledger.
    m.settings['workspace.agentRunMaxConcurrentPerTeam'] = 1;
    m.slots = [
      { launchedAt: new Date(1), teamId: 'team-1', workflowId: 'crashed' },
      { launchedAt: new Date(2), teamId: 'team-1', workflowId: 'wf-1' },
    ];
    m.temporal = { crashed: 'finished' };
    await runAgentTask({ request: request() });
    expect(m.closeRows).toHaveBeenCalledTimes(1);
    expect(m.closeRows.mock.calls[0]?.[0]).toMatchObject({
      data: { currentStatus: 'FAILED' },
      where: { temporalWorkflowId: { in: ['crashed'] } },
    });
  });

  it('keeps counting a row whose workflow is still running', async () => {
    m.settings['workspace.agentRunMaxConcurrentPerTeam'] = 1;
    m.slots = [
      { launchedAt: new Date(1), teamId: 'team-1', workflowId: 'running' },
      { launchedAt: new Date(2), teamId: 'team-1', workflowId: 'wf-1' },
    ];
    const f = await failureOf(runAgentTask({ request: request() }));
    expect(f.type).toBe('AGENT_RUN_CONCURRENCY_EXCEEDED');
    expect(m.closeRows).not.toHaveBeenCalled();
  });

  it('does not free the slot when Temporal cannot be reached', async () => {
    m.settings['workspace.agentRunMaxConcurrentPerTeam'] = 1;
    m.slots = [
      { launchedAt: new Date(1), teamId: 'team-1', workflowId: 'unknown' },
      { launchedAt: new Date(2), teamId: 'team-1', workflowId: 'wf-1' },
    ];
    m.temporal = { unknown: 'down' };
    const f = await failureOf(runAgentTask({ request: request() }));
    expect(f.type).toBe('AGENT_RUN_CONCURRENCY_EXCEEDED');
    expect(m.closeRows).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a run that is not among the oldest N in flight', async () => {
    m.settings['workspace.agentRunMaxConcurrentPerTeam'] = 1;
    m.slots = [
      { launchedAt: new Date(1), teamId: 'team-1', workflowId: 'older' },
      { launchedAt: new Date(2), teamId: 'team-1', workflowId: 'wf-1' },
    ];
    const f = await failureOf(runAgentTask({ request: request() }));
    expect(f.type).toBe('AGENT_RUN_CONCURRENCY_EXCEEDED');
    expect(createWorkspace).not.toHaveBeenCalled();
  });
});

describe('bounds', () => {
  it('clamps a launch cap above the ceiling down to the ceiling, never up', async () => {
    m.settings['workspace.agentRunMaxSteps'] = 30;
    m.settings['workspace.agentRunMaxWallClockSeconds'] = 600;
    const r = await runAgentTask({
      request: request({
        payload: {
          agentRef: 'contentWriter',
          deliver: 'none',
          maxSteps: 400,
          maxWallClockSeconds: 9000,
        },
      }),
    });
    expect(r.effective).toEqual({ maxSteps: 30, maxWallClockSeconds: 600 });
    expect(m.runAgent.mock.calls[0]?.[2]).toMatchObject({ maxSteps: 30, perStepAccounting: true });
  });

  it('lets a launch lower the ceiling', async () => {
    const r = await runAgentTask({
      request: request({
        payload: {
          agentRef: 'contentWriter',
          deliver: 'none',
          maxSteps: 5,
          maxWallClockSeconds: 120,
        },
      }),
    });
    expect(r.effective).toEqual({ maxSteps: 5, maxWallClockSeconds: 120 });
  });

  it('runs the agent loop with per-step accounting and a deadline', async () => {
    await runAgentTask({ request: request() });
    const opts = m.runAgent.mock.calls[0]?.[2] as {
      abortSignal: AbortSignal;
      perStepAccounting: boolean;
    };
    expect(opts.perStepAccounting).toBe(true);
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('names the workspace tools it hands the loop as self-recording, so they are not recorded twice', async () => {
    await runAgentTask({ request: request() });
    const spec = m.runAgent.mock.calls[0]?.[0] as { tools: Record<string, unknown> };
    const opts = m.runAgent.mock.calls[0]?.[2] as { selfRecordingTools: Set<string> };
    expect([...opts.selfRecordingTools].sort()).toEqual(Object.keys(spec.tools).sort());
    expect(opts.selfRecordingTools.size).toBeGreaterThan(0);
  });
});

describe('tool grants and agent scope', () => {
  /** The tools the agent loop is actually handed, after the real resolution. */
  const granted = () => {
    const spec = m.runAgent.mock.calls[0]?.[0] as { tools: Record<string, unknown> };
    return Object.keys(spec.tools).sort();
  };

  it('toolKeys null grants the read tools only', async () => {
    m.toolKeys = null;
    await runAgentTask({ request: request() });
    expect(granted()).toEqual(['listDirectory', 'readFile']);
  });

  it('toolKeys [] grants no tools at all', async () => {
    m.toolKeys = [];
    await runAgentTask({ request: request() });
    expect(granted()).toEqual([]);
  });

  it('toolKeys ["mcp"] grants no workspace tool (MCP only)', async () => {
    m.toolKeys = ['mcp'];
    await runAgentTask({ request: request() });
    expect(granted()).toEqual([]);
  });

  it('grants a write tool only when it is named, and only the ones named', async () => {
    m.toolKeys = ['writeFile', 'bash'];
    await runAgentTask({ request: request() });
    expect(granted()).toEqual(['bash', 'writeFile']);
  });

  it('naming a read tool alone does not add a write tool', async () => {
    m.toolKeys = ['readFile'];
    await runAgentTask({ request: request() });
    expect(granted()).toEqual(['readFile']);
  });

  it('hands runAgent the org/pinned model, so every step is priced at it and not at a team override', async () => {
    // The owning team (team-1, on the ambient context) overrides the model; the run
    // resolves without a team, so it gets the org-scope model. runAgent prices each
    // step at spec.modelSpec, which is therefore the org model.
    vi.mocked(resolveAgent).mockImplementation((async (key: string, ctx: { teamId?: string }) => ({
      key,
      model: {
        apiBase: undefined,
        apiKey: 'k',
        spec: ctx.teamId ? 'anthropic/team-override' : 'anthropic/org-model',
        systemPrompt: null,
      },
      skills: [],
      toolKeys: m.toolKeys,
      version: 3,
    })) as never);

    await runAgentTask({ request: request() });

    const spec = m.runAgent.mock.calls[0]?.[0] as { modelSpec: string };
    expect(spec.modelSpec).toBe('anthropic/org-model');
  });

  it('resolves the agent with no team, template or channel scope (shared-team launch safe)', async () => {
    await runAgentTask({
      request: request({ payload: { agentRef: 'contentWriter@2', deliver: 'none' } }),
    });
    const ctx = m.resolveAgentSpec.mock.calls[0]?.[1];
    // The run's skill pins travel with its agent pins into the agent-run context.
    expect(ctx).toEqual({
      agentVersions: { contentWriter: 2 },
      orgId: 'org-1',
      skillRevisions: { 'skill-1': 4 },
    });
    expect(ctx).not.toHaveProperty('teamId');
    expect(ctx).not.toHaveProperty('workflowTemplateId');
  });
});

describe('deliver none', () => {
  it('never creates a trusted container, pushes or opens a PR', async () => {
    const r = await runAgentTask({ request: request() });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(m.push).not.toHaveBeenCalled();
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.createPr).not.toHaveBeenCalled();
    expect(r.gate).toBe('not_applicable');
    expect(r.diffVerified).toBe(false);
    expect(r.text).toBe('done');
  });
});

describe('delivery: trust boundary and gate-before-push', () => {
  const deliver = (d: 'branch' | 'draft_pr') =>
    request({ payload: { agentRef: 'contentWriter', deliver: d } });

  it('judges and pushes from a FRESH container pinned to the base SHA, never the agent container', async () => {
    const r = await runAgentTask({ request: deliver('branch') });
    expect(createWorkspace).toHaveBeenCalledTimes(2);
    // Second workspace: the base SHA pins the trusted checkout.
    expect(vi.mocked(createWorkspace).mock.calls[1]?.[4]).toBe('base-sha');
    expect(m.importTree).toHaveBeenCalledWith(m.agentWs, m.trustedWs);
    expect(m.gate.mock.calls[0]?.[0]).toBe(m.trustedWs);
    expect(m.push.mock.calls[0]?.[0]).toBe(m.trustedWs);
    // The agent's container is never asked to use the credential.
    expect(m.agentWs.gitAuthed).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      branch: 'auto/agent-0a1b2c3d111122223333444455556666',
      gate: 'passed',
      headSha: GATED.sha,
    });
    expect(r.prUrl).toBeUndefined();
  });

  it('gates strictly before pushing', async () => {
    const order: string[] = [];
    m.gate.mockImplementation(async () => {
      order.push('gate');
      return GATED;
    });
    m.push.mockImplementation(async () => {
      order.push('push');
    });
    await runAgentTask({ request: deliver('branch') });
    expect(order).toEqual(['gate', 'push']);
  });

  it('a failing gate means no push, no PR, and both containers are destroyed', async () => {
    m.gate.mockRejectedValue(
      ApplicationFailure.nonRetryable(
        'Security scan failed with critical findings:\nx',
        'SECURITY_GATE_FAILURE'
      )
    );
    const f = await failureOf(runAgentTask({ request: deliver('draft_pr') }));
    expect(f.type).toBe('SECURITY_GATE_FAILURE');
    expect(m.push).not.toHaveBeenCalled();
    expect(m.createPr).not.toHaveBeenCalled();
    expect(m.agentWs.destroy).toHaveBeenCalled();
    expect(m.trustedWs.destroy).toHaveBeenCalled();
    expect(m.persist).toHaveBeenCalled();
  });

  it('an empty change publishes nothing', async () => {
    m.commit.mockResolvedValue({ empty: true });
    const r = await runAgentTask({ request: deliver('draft_pr') });
    expect(r.gate).toBe('no_changes');
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
    expect(m.createPr).not.toHaveBeenCalled();
  });

  it('opens a DRAFT pull request for draft_pr, with the agent text defused of mentions', async () => {
    m.runAgent.mockResolvedValue({ stepCount: 2, text: 'ping @octocat and @org/team' });
    const r = await runAgentTask({ request: deliver('draft_pr') });
    expect(m.createPr).toHaveBeenCalledTimes(1);
    const arg = m.createPr.mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      baseBranch: 'main',
      draft: true,
      headBranch: 'auto/agent-0a1b2c3d111122223333444455556666',
    });
    expect(arg.body).not.toMatch(/@octocat/);
    expect(r).toMatchObject({ prNumber: 7, prUrl: 'https://x/pull/7' });
  });

  it("tracks the draft PR on the run's own ledger row", async () => {
    await runAgentTask({ request: deliver('draft_pr') });
    expect(m.prCreate).toHaveBeenCalledTimes(1);
    expect(m.prCreate.mock.calls[0]?.[0]).toEqual({
      data: {
        ciStatus: 'PENDING',
        headSha: GATED.sha,
        isDraft: true,
        prNumber: 7,
        repoId: 'repo-1',
        status: 'OPEN',
        title: '[auto-swe] agent run: fix the typo',
        workflowId: 'ledger-1',
      },
    });
  });

  it('never updates a row that already holds the same repository and number', async () => {
    // The host just opened a new PR, so a row with this number is a different one.
    // The unique index refuses the insert; the other row is left as it is.
    m.prCreate.mockRejectedValue(
      new Error('Unique constraint failed on pull_requests_repo_id_pr_number_uidx')
    );
    const r = await runAgentTask({ request: deliver('draft_pr') });
    expect(m.prUpdate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ gate: 'passed', prNumber: 7 });
    expect(traceEvents()).toContainEqual(
      expect.objectContaining({
        error: expect.stringContaining('Unique constraint'),
        toolName: 'pr.record_failed',
      })
    );
  });

  it('does not track a PR for deliver=branch', async () => {
    await runAgentTask({ request: deliver('branch') });
    expect(m.prCreate).not.toHaveBeenCalled();
  });

  it('still returns the opened PR when the tracking row cannot be written', async () => {
    m.prCreate.mockRejectedValue(new Error('db down'));
    const r = await runAgentTask({ request: deliver('draft_pr') });
    expect(r).toMatchObject({ gate: 'passed', prNumber: 7 });
    expect(traceEvents().map((e) => e.toolName)).toContain('pr.record_failed');
  });

  it('records no failure event when the row is written', async () => {
    await runAgentTask({ request: deliver('draft_pr') });
    expect(traceEvents().map((e) => e.toolName)).not.toContain('pr.record_failed');
  });

  it('puts agent-controlled file paths in a fence they cannot close, with mentions defused', async () => {
    m.gate.mockResolvedValue({
      ...GATED,
      filesChanged: [
        {
          language: 'md',
          linesAdded: 1,
          linesRemoved: 0,
          operation: 'CREATE',
          path: 'a`` ![x](http://evil/p.png) @octocat\n`b',
        },
      ],
    });
    await runAgentTask({ request: deliver('draft_pr') });
    const body = m.createPr.mock.calls[0]?.[0].body as string;
    // Longest backtick run in the path is 2, so the fence is at least 3 and the
    // path sits wholly inside it, on one line, with no live mention.
    expect(body).toContain(
      '```\na`` ![x](http://evil/p.png) @\u200boctocat?`b (CREATE, +1/-0)\n```'
    );
    expect(body).not.toMatch(/@octocat/);
  });

  it('uses a fence longer than any backtick run in a path', async () => {
    m.gate.mockResolvedValue({
      ...GATED,
      filesChanged: [
        { language: '', linesAdded: 0, linesRemoved: 0, operation: 'CREATE', path: 'a```b' },
      ],
    });
    await runAgentTask({ request: deliver('draft_pr') });
    const body = m.createPr.mock.calls[0]?.[0].body as string;
    expect(body).toContain('````\na```b (CREATE, +0/-0)\n````');
  });

  it('bounds filesChanged in count and path length', async () => {
    m.gate.mockResolvedValue({
      ...GATED,
      filesChanged: Array.from({ length: 500 }, (_, i) => ({
        language: '',
        linesAdded: 0,
        linesRemoved: 0,
        operation: 'CREATE' as const,
        path: `${'p'.repeat(4000)}${i}`,
      })),
    });
    const r = await runAgentTask({ request: deliver('branch') });
    expect(r.filesChanged).toHaveLength(200);
    expect(Math.max(...r.filesChanged.map((f) => f.path.length))).toBeLessThanOrEqual(303);
  });

  it('keeps the pushed branch and fails clearly when the repo cannot hold drafts', async () => {
    m.createPr.mockRejectedValue(new DraftPullRequestUnsupportedError('no drafts'));
    const f = await failureOf(runAgentTask({ request: deliver('draft_pr') }));
    expect(f.type).toBe('DRAFT_PR_UNSUPPORTED');
    expect(f.nonRetryable).toBe(true);
    expect(f.message).toContain('auto/agent-0a1b2c3d111122223333444455556666');
    expect(m.push).toHaveBeenCalledTimes(1);
    // Never a ready-for-review fallback.
    expect(m.createPr).toHaveBeenCalledTimes(1);
  });

  it('a wall-clocked run is still gated and published', async () => {
    m.runAgent.mockResolvedValue({ stepCount: 9, stoppedReason: 'wall_clock', text: 'partial' });
    const r = await runAgentTask({ request: deliver('branch') });
    expect(r.stoppedReason).toBe('wall_clock');
    expect(m.gate).toHaveBeenCalledTimes(1);
    expect(m.push).toHaveBeenCalledTimes(1);
  });

  it('refuses before any container exists when the model is unpriced under a USD cap', async () => {
    assertPricedMock.mockRejectedValueOnce(
      ApplicationFailure.nonRetryable('no price for the model', 'MODEL_UNPRICED')
    );
    const f = await failureOf(runAgentTask({ request: request() }));
    expect(f.type).toBe('MODEL_UNPRICED');
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it('checks the price of the model it will actually run (org/pinned scope)', async () => {
    await runAgentTask({ request: request() });
    expect(assertPricedMock).toHaveBeenCalledWith(expect.stringContaining('/'));
  });

  it('an agent failure (e.g. budget) publishes nothing and still cleans up', async () => {
    m.runAgent.mockRejectedValue(ApplicationFailure.nonRetryable('over budget', 'BUDGET_EXCEEDED'));
    const f = await failureOf(runAgentTask({ request: deliver('branch') }));
    expect(f.type).toBe('BUDGET_EXCEEDED');
    expect(m.push).not.toHaveBeenCalled();
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(m.agentWs.destroy).toHaveBeenCalled();
  });
});

describe('the Claude Code harness, for an agent that asks for it', () => {
  beforeEach(() => {
    m.runtime = 'claude-code';
  });

  it('stays on Mastra for an agent with no opinion, and says why on the trace', async () => {
    m.runtime = null;
    await runAgentTask({ request: request() });
    expect(m.runAgent).toHaveBeenCalledTimes(1);
    expect(m.claudeCodeRuntime).not.toHaveBeenCalled();
    const tracer = m.persist.mock.calls[0]?.[0] as {
      records: Array<{ toolName: string; outputJson?: unknown }>;
    };
    expect(tracer.records).toContainEqual(
      expect.objectContaining({
        outputJson: { agentKey: 'contentWriter', runtime: 'mastra', source: 'default' },
        toolName: 'agent.runtime',
      })
    );
  });

  it('runs one bounded harness turn in the agent container instead of the Mastra loop', async () => {
    const result = await runAgentTask({ request: request() });

    expect(m.runAgent).not.toHaveBeenCalled();
    expect(m.claudeCodeRuntime).toHaveBeenCalledTimes(1);
    const options = m.claudeCodeRuntime.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      access: { apiBase: undefined, apiKey: 'k', modelId: 'x' },
      loadProjectSettings: true,
      maxTurns: 50,
      workspace: m.agentWs,
    });
    expect(options.deadline).toBeInstanceOf(AbortSignal);
    expect(m.harnessTurn).toHaveBeenCalledTimes(1);
    const turn = m.harnessTurn.mock.calls[0]?.[0];
    expect(turn.user).toBe('fix the typo');
    expect(turn.system).toContain('Do not run `git commit` or `git push`');
    expect(m.recordUsage).toHaveBeenCalledWith(
      'wf-1',
      'contentWriter',
      { inputTokens: 10, outputTokens: 5 },
      'llm.agent_run',
      'anthropic/x'
    );
    expect(result).toMatchObject({ costUsd: 0.25, steps: 6, text: 'harness done' });
  });

  it('checks the budget before the turn', async () => {
    m.assertBudget.mockImplementationOnce(async () => {
      expect(m.harnessTurn).not.toHaveBeenCalled();
    });
    await runAgentTask({ request: request() });
    expect(m.assertBudget).toHaveBeenCalledWith('agent.contentWriter');
  });

  it.each([
    [null, ['Read', 'Glob', 'Grep']],
    [[], []],
    [['mcp'], []],
    [['bash'], ['Bash']],
    [
      ['readFile', 'writeFile'],
      ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    ],
  ])(
    'grants the harness exactly what the agent-run rule grants for toolKeys %j',
    async (keys, tools) => {
      m.toolKeys = keys as string[] | null;
      await runAgentTask({ request: request() });
      expect(m.claudeCodeRuntime.mock.calls[0]?.[0].tools).toEqual(tools);
    }
  );

  it('refuses a model the harness cannot drive before any container exists', async () => {
    m.modelSpec = 'openai/gpt-6.1-sol';
    const f = await failureOf(runAgentTask({ request: request() }));
    expect(f.type).toBe('HARNESS_UNSUPPORTED_MODEL');
    expect(f.nonRetryable).toBe(true);
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('binds no MCP server, and says so on the trace', async () => {
    m.mcpConnectionId = 'mcp-1';
    m.toolKeys = ['readFile', 'mcp'];
    await runAgentTask({ request: request() });
    const tracer = m.persist.mock.calls[0]?.[0] as {
      records: Array<{ toolName: string; outputJson?: unknown }>;
    };
    expect(tracer.records).toContainEqual(
      expect.objectContaining({
        outputJson: { agentKey: 'contentWriter', mcpConnectionId: 'mcp-1' },
        toolName: 'agent.runtime_mcp_skipped',
      })
    );
  });

  it('debits each call the harness finishes, and reports the whole turn’s cost', async () => {
    m.claudeCodeRuntime.mockImplementation(() => ({
      runTurn: async (input: { onCallSpent: (s: unknown) => Promise<void> }) => {
        // The runtime hands each completed call to the turn's per-call accounting.
        await input.onCallSpent([
          { modelSpec: 'anthropic/x', usage: { inputTokens: 100, outputTokens: 20 } },
        ]);
        return { steps: 2, text: 'harness done', toolCallCount: 1, usageByModel: [] };
      },
    }));

    const result = await runAgentTask({ request: request() });

    expect(m.recordUsage).toHaveBeenCalledWith(
      'wf-1',
      'contentWriter',
      { inputTokens: 100, outputTokens: 20 },
      'llm.agent_run',
      'anthropic/x'
    );
    // Once before the turn, once after the call.
    expect(m.assertBudget).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ costUsd: 0.25, text: 'harness done' });
  });

  it('stops with the budget failure a call’s debit raised, publishing nothing', async () => {
    const budget = Object.assign(new Error('Budget already exhausted'), {
      type: 'BUDGET_EXCEEDED',
    });
    m.claudeCodeRuntime.mockImplementation(() => ({
      runTurn: (input: { onCallSpent: (s: unknown) => Promise<void> }) =>
        input.onCallSpent([
          { modelSpec: 'anthropic/x', usage: { inputTokens: 1, outputTokens: 1 } },
        ]),
    }));
    m.assertBudget.mockResolvedValueOnce(undefined).mockRejectedValueOnce(budget);
    await expect(
      runAgentTask({
        request: request({ payload: { agentRef: 'contentWriter', deliver: 'branch' } }),
      })
    ).rejects.toBe(budget);
    expect(m.push).not.toHaveBeenCalled();
    expect(m.agentWs.destroy).toHaveBeenCalled();
  });

  it('a wall-clocked harness run is still gated and published', async () => {
    m.harnessTurn.mockResolvedValue({ stoppedReason: 'wall_clock', toolCallCount: 1 });
    const result = await runAgentTask({
      request: request({ payload: { agentRef: 'contentWriter', deliver: 'branch' } }),
    });
    expect(result).toMatchObject({ gate: 'passed', stoppedReason: 'wall_clock' });
    expect(m.push).toHaveBeenCalledTimes(1);
  });

  it('a harness failure publishes nothing and still cleans up', async () => {
    m.harnessTurn.mockRejectedValue(new Error('Claude Code ended with error_during_execution'));
    await expect(
      runAgentTask({
        request: request({ payload: { agentRef: 'contentWriter', deliver: 'branch' } }),
      })
    ).rejects.toThrow('error_during_execution');
    expect(m.push).not.toHaveBeenCalled();
    expect(m.agentWs.destroy).toHaveBeenCalled();
    expect(m.persist).toHaveBeenCalledTimes(1);
  });
});
