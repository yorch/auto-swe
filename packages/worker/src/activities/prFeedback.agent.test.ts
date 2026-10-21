import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  core: vi.fn(async () => ({
    baseSha: 'a'.repeat(40),
    diff: 'diff',
    filesChanged: [],
    headSha: 'c'.repeat(40),
    text: 'did it',
  })),
  findFire: vi.fn(async () => null as unknown),
  findPr: vi.fn(async () => null as unknown),
  findRepo: vi.fn(async () => null as unknown),
  findRun: vi.fn(async () => null as unknown),
  findRunWf: vi.fn(async () => null as unknown),
  logUsable: vi.fn(async () => true),
  prompts: [] as string[],
  settings: {
    'workspace.agentRunMaxConcurrentGlobal': 4,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
    'workspace.agentRunMaxSteps': 10,
    'workspace.agentRunMaxWallClockSeconds': 7200,
  } as Record<string, unknown>,
  workflowId: 'prfb-wf-1' as string | undefined,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    automationFire: { findFirst: m.findFire },
    connection: { findUniqueOrThrow: m.findRepo },
    pullRequest: { findFirst: m.findPr },
    workflowRun: { findFirst: m.findRun, findUnique: m.findRunWf },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSettings: vi.fn(async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, m.settings[k]]))
  ),
}));
vi.mock('@temporalio/activity', async (orig) => ({
  ...(await orig<typeof import('@temporalio/activity')>()),
  activityInfo: () => {
    if (m.workflowId === undefined) {
      throw new Error('Activity context is not available');
    }
    return { workflowExecution: { workflowId: m.workflowId } };
  },
}));
vi.mock('../lib/activityContext.js', () => ({ persistActivityTrace: vi.fn(async () => true) }));
vi.mock('../lib/execUtils.js', () => ({
  withHeartbeat: (_l: string, p: Promise<unknown>) => p,
}));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({ orgId: 'org-1', teamId: 'team-1' })),
}));
vi.mock('../lib/ciLogGuard.js', async (orig) => {
  const real = await orig<typeof import('../lib/ciLogGuard.js')>();
  return { ...real, ciLogIsUsable: m.logUsable };
});
vi.mock('./runAgentTask.js', () => ({
  runAgentTaskCore: vi.fn(async (args: { prompt: string }) => {
    m.prompts.push(args.prompt);
    return m.core();
  }),
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({}),
  toRepoRef: () => ({ organizationName: 'acme', repoName: 'api' }),
}));

import { type GatherResult, runAgentPrFeedbackTask } from './prFeedback.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const WID = 'prfb-wf-1';

const request = (): RepoWorkRequest =>
  ({
    description: 'WEBHOOK TEXT THAT MUST NOT REACH THE PROMPT',
    externalTicketId: 'prfb-9-777',
    payload: {
      baseBranch: 'feature/work',
      connectionId: CONN,
      feedbackEventId: '777',
      feedbackEventKind: 'issue_comment',
      feedbackOrigin: 'agent_run',
      feedbackTrigger: 'command',
      pullRequestNumber: 9,
    },
    repoId: CONN,
    workRequestId: 'wr-1',
  }) as unknown as RepoWorkRequest;

const gather = (over: Record<string, unknown> = {}): GatherResult =>
  ({
    agentRef: 'impl',
    brief: '<review-feedback>T1 fix</review-feedback>',
    headRef: 'feature/work',
    headSha: 'a'.repeat(40),
    origin: 'agent_run',
    originalTask: 'the original task',
    workBranch: 'auto/prfb-9-777',
    ...over,
  }) as unknown as GatherResult;

function base() {
  m.findRunWf.mockResolvedValue({
    template: { name: 'address-pr-feedback', teamId: null },
    templateId: 't1',
  });
  m.findFire.mockResolvedValue({
    source: 'github.pull_request.feedback',
    temporalWorkflowId: WID,
  });
  m.findPr.mockResolvedValue({ workflow: { temporalWorkflowId: 'wf-original' } });
  m.findRun.mockResolvedValue({
    template: { name: 'Agent Run', origin: 'system:agent-run', teamId: null },
    workRequest: { description: 'the original task', payload: { agentRef: 'impl' } },
  });
  m.findRepo.mockResolvedValue({ id: CONN });
}

beforeEach(() => {
  for (const f of Object.values(m)) {
    if (typeof f === 'function' && 'mockReset' in f) {
      f.mockReset();
    }
  }
  m.prompts.length = 0;
  m.settings = {
    'workspace.agentRunMaxConcurrentGlobal': 4,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
    'workspace.agentRunMaxSteps': 10,
    'workspace.agentRunMaxWallClockSeconds': 7200,
  };
  m.logUsable.mockResolvedValue(true);
  m.workflowId = WID;
  m.core.mockResolvedValue({
    baseSha: 'a'.repeat(40),
    diff: 'diff',
    filesChanged: [],
    headSha: 'c'.repeat(40),
    text: 'did it',
  });
});

describe('runAgentPrFeedbackTask — checks', () => {
  it('runs only under the GLOBAL built-in template', async () => {
    base();
    m.findRunWf.mockResolvedValue({ template: { name: 'other', teamId: null } });
    await expect(
      runAgentPrFeedbackTask({ gather: gather(), request: request() })
    ).rejects.toMatchObject({ type: 'PR_FEEDBACK_NOT_FEEDBACK_TEMPLATE' });
    m.findRunWf.mockResolvedValue({ template: { name: 'address-pr-feedback', teamId: 't' } });
    await expect(
      runAgentPrFeedbackTask({ gather: gather(), request: request() })
    ).rejects.toMatchObject({ type: 'PR_FEEDBACK_NOT_FEEDBACK_TEMPLATE' });
  });
  it('runs only in the automation’s run', async () => {
    base();
    m.findFire.mockResolvedValue(null);
    await expect(
      runAgentPrFeedbackTask({ gather: gather(), request: request() })
    ).rejects.toMatchObject({ type: 'PR_FEEDBACK_NOT_AUTOMATION_RUN' });
  });
  it('refuses an agentRef the original run did not use, and a non-agent PR', async () => {
    base();
    m.findRun.mockResolvedValue({
      template: { name: 'Agent Run', origin: 'system:agent-run', teamId: null },
      workRequest: { description: 't', payload: { agentRef: 'different' } },
    });
    await expect(
      runAgentPrFeedbackTask({ gather: gather(), request: request() })
    ).rejects.toMatchObject({ type: 'PR_FEEDBACK_NOT_AGENT_RUN' });
    await expect(
      runAgentPrFeedbackTask({ gather: gather({ origin: 'workflow' }), request: request() })
    ).rejects.toMatchObject({ type: 'PR_FEEDBACK_NOT_AGENT_RUN' });
  });
  it('refuses a non-launchable key and a zero ceiling', async () => {
    base();
    m.findRun.mockResolvedValue({
      template: { name: 'Agent Run', origin: 'system:agent-run', teamId: null },
      workRequest: { description: 't', payload: { agentRef: 'ciTriager' } },
    });
    await expect(
      runAgentPrFeedbackTask({ gather: gather({ agentRef: 'ciTriager' }), request: request() })
    ).rejects.toMatchObject({ type: 'AGENT_NOT_LAUNCHABLE' });
    m.findRun.mockResolvedValue({
      template: { name: 'Agent Run', origin: 'system:agent-run', teamId: null },
      workRequest: { description: 't', payload: { agentRef: 'impl' } },
    });
    m.settings['workspace.agentRunMaxConcurrentPerTeam'] = 0;
    await expect(
      runAgentPrFeedbackTask({ gather: gather(), request: request() })
    ).rejects.toMatchObject({ type: 'AGENT_RUNS_DISABLED' });
  });
});

describe('runAgentPrFeedbackTask — prompt and CI logs', () => {
  it('prompts with the original task + fenced brief; never request.description', async () => {
    base();
    const r = await runAgentPrFeedbackTask({ gather: gather(), request: request() });
    expect(r.codeResult.branch).toBe('auto/prfb-9-777');
    const prompt = m.prompts[0];
    expect(prompt).toContain('the original task');
    expect(prompt).toContain('<review-feedback>');
    expect(prompt).not.toContain('WEBHOOK TEXT THAT MUST NOT REACH THE PROMPT');
  });
  it('refuses unusable CI logs and fences usable ones', async () => {
    base();
    m.logUsable.mockResolvedValue(false);
    await expect(
      runAgentPrFeedbackTask({ ciLogs: 'some log', gather: gather(), request: request() })
    ).rejects.toMatchObject({ type: 'CI_LOGS_REFUSED' });
    m.logUsable.mockResolvedValue(true);
    await runAgentPrFeedbackTask({ ciLogs: 'some log', gather: gather(), request: request() });
    expect(m.prompts[0]).toContain('<ci-logs>');
  });
});
