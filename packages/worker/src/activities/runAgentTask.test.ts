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
  commit: vi.fn(),
  createPr: vi.fn(),
  gate: vi.fn(),
  importTree: vi.fn(async () => 10),
  ledger: { repoId: 'repo-1' } as unknown,
  persist: vi.fn(async () => {}),
  push: vi.fn(),
  resolveAgentSpec: vi.fn(),
  run: {
    template: { name: 'Agent Run', origin: 'system:agent-run', teamId: null },
    templateId: 'tpl-1',
  } as unknown,
  runAgent: vi.fn(),
  settings: {
    'workspace.agentRunAllowWorkflowChanges': false,
    'workspace.agentRunMaxConcurrentGlobal': 4,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
    'workspace.agentRunMaxSteps': 50,
    'workspace.agentRunMaxWallClockSeconds': 1800,
    'workspace.maxToolOutputChars': 20000,
  } as Record<string, unknown>,
  slots: [] as Array<{ workflowId: string; teamId: string | null; launchedAt: Date }>,
  toolKeys: null as string[] | null,
  trustedWs: {
    containerId: 'trusted-ws',
    destroy: vi.fn(async () => {}),
    gitAuthed: vi.fn(async () => ''),
  },
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findFirst: vi.fn(async () => m.ledger) },
    connection: {
      findUniqueOrThrow: vi.fn(async () => ({
        defaultBranch: 'main',
        executorImage: null,
        id: 'repo-1',
        installation: null,
      })),
    },
    workflowRun: { findUnique: vi.fn(async () => m.run) },
  },
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
    teamId: 'team-1',
    workflowTemplateId: 'tpl-1',
  })),
}));
vi.mock('../lib/config/agentResolver.js', () => ({
  resolveAgent: vi.fn(async (key: string) => ({
    key,
    model: { apiBase: undefined, apiKey: 'k', spec: 'anthropic/x', systemPrompt: null },
    skills: [],
    toolKeys: m.toolKeys,
    version: 3,
  })),
}));
// The REAL resolveAgentSpec runs (it intersects the offered tools with the
// agent's toolKeys again), so the tool tests see what the agent is really given.
vi.mock('../lib/config/agentSpec.js', async (orig) => {
  const actual = await orig<typeof import('../lib/config/agentSpec.js')>();
  m.resolveAgentSpec.mockImplementation(actual.resolveAgentSpec);
  return { resolveAgentSpec: m.resolveAgentSpec };
});
vi.mock('../lib/models.js', () => ({ resolveModel: vi.fn(() => 'model') }));
vi.mock('../lib/config/mcpConnection.js', () => ({ resolveAgentMcpUrl: vi.fn(async () => null) }));
vi.mock('../agents/mcpTools.js', () => ({ loadMcpTools: vi.fn() }));
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
vi.mock('./agentRunFinalize.js', () => ({
  commitTrustedTree: m.commit,
  gateTrustedCommit: m.gate,
  importAgentTree: m.importTree,
  pushGatedCommit: m.push,
}));

import { DraftPullRequestUnsupportedError } from '../lib/scm/types.js';
import { runAgentTask } from './runAgentTask.js';
import { createWorkspace } from './workspace.js';

const request = (over: Record<string, unknown> = {}) =>
  ({
    description: 'fix the typo',
    externalTicketId: 'agent-0a1b2c3d',
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

async function failureOf(p: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await p;
  } catch (e) {
    return e as ApplicationFailure;
  }
  throw new Error('expected a failure');
}

beforeEach(() => {
  vi.clearAllMocks();
  m.run = {
    template: { name: 'Agent Run', origin: 'system:agent-run', teamId: null },
    templateId: 'tpl-1',
  };
  m.ledger = { repoId: 'repo-1' };
  m.slots = [{ launchedAt: new Date(1), teamId: 'team-1', workflowId: 'wf-1' }];
  m.toolKeys = null;
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

  it('resolves the agent with no team, template or channel scope (shared-team launch safe)', async () => {
    await runAgentTask({
      request: request({ payload: { agentRef: 'contentWriter@2', deliver: 'none' } }),
    });
    const ctx = m.resolveAgentSpec.mock.calls[0]?.[1];
    expect(ctx).toEqual({ agentVersions: { contentWriter: 2 }, orgId: 'org-1' });
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
    expect(r).toMatchObject({ branch: 'auto/agent-0a1b2c3d', gate: 'passed', headSha: GATED.sha });
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
      headBranch: 'auto/agent-0a1b2c3d',
    });
    expect(arg.body).not.toMatch(/@octocat/);
    expect(r).toMatchObject({ prNumber: 7, prUrl: 'https://x/pull/7' });
  });

  it('keeps the pushed branch and fails clearly when the repo cannot hold drafts', async () => {
    m.createPr.mockRejectedValue(new DraftPullRequestUnsupportedError('no drafts'));
    const f = await failureOf(runAgentTask({ request: deliver('draft_pr') }));
    expect(f.type).toBe('DRAFT_PR_UNSUPPORTED');
    expect(f.nonRetryable).toBe(true);
    expect(f.message).toContain('auto/agent-0a1b2c3d');
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

  it('an agent failure (e.g. budget) publishes nothing and still cleans up', async () => {
    m.runAgent.mockRejectedValue(ApplicationFailure.nonRetryable('over budget', 'BUDGET_EXCEEDED'));
    const f = await failureOf(runAgentTask({ request: deliver('branch') }));
    expect(f.type).toBe('BUDGET_EXCEEDED');
    expect(m.push).not.toHaveBeenCalled();
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(m.agentWs.destroy).toHaveBeenCalled();
  });
});
