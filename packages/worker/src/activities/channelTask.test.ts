import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
    channelMonthlyUsage: { findUnique: vi.fn() },
    connection: { findMany: vi.fn() },
    runInput: { create: vi.fn() },
    slackChannel: { findUnique: vi.fn() },
    workflowTemplate: { findFirst: vi.fn() },
  };
  return { prisma: prismaMock };
});

vi.mock('@auto-swe/shared/lib/billing', () => ({
  currentYearMonth: vi.fn().mockReturnValue('2026-06'),
}));

// Phase B: stub the default-SWE-template resolver so the code-task tests don't drag
// in the templates activity's whole dependency chain (slackNotify, trackerSync, …).
vi.mock('./templates.js', () => ({
  resolveTemplateForRepo: vi.fn(),
}));

import { prisma } from '@auto-swe/shared/db';
import {
  createChannelCodeTaskRun,
  createChannelTaskRun,
  isChannelOverBudgetForTask,
  resolveChannelRepo,
} from './channelTask.js';
import { resolveTemplateForRepo } from './templates.js';

const findTemplate = vi.mocked(prisma.workflowTemplate.findFirst);
const createRunInput = vi.mocked(prisma.runInput.create);
const findChannel = vi.mocked(prisma.slackChannel.findUnique);
const findUsage = vi.mocked(prisma.channelMonthlyUsage.findUnique);
const findConnections = vi.mocked(prisma.connection.findMany);
const resolveTemplate = vi.mocked(resolveTemplateForRepo);

beforeEach(() => {
  vi.clearAllMocks();
  findTemplate.mockResolvedValue({ activeVersion: 1, id: 'tmpl-channel-task' } as never);
  createRunInput.mockResolvedValue({ id: 'runinput-1' } as never);
  resolveTemplate.mockResolvedValue({ templateId: 'tmpl-swe', templateVersion: 3 });
});

/** Build a `git_repo` connection row as `prisma.connection.findMany` returns it. */
function gitRepo(id: string, org: string, repo: string) {
  return { id, organizationName: org, repoName: repo, type: 'git_repo' };
}

describe('createChannelTaskRun', () => {
  const INPUT = {
    channelId: 'chan-1',
    description: 'Investigate the flaky test and summarise the root cause.',
    slackChannelId: 'C123',
    threadTs: '111.222',
    title: 'Investigate flaky test',
  };

  it('builds a deterministic per-thread workflowId (sanitized)', async () => {
    const result = await createChannelTaskRun(INPUT);

    // chantask-<channelId>-<threadTs> with `.` sanitized to `-`.
    expect(result.workflowId).toBe('chantask-chan-1-111-222');
  });

  it('creates a RunInput threading the Slack channel + thread for result reporting', async () => {
    await createChannelTaskRun(INPUT);

    expect(createRunInput).toHaveBeenCalledTimes(1);
    const data = createRunInput.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      description: INPUT.description,
      externalTicketId: 'slack-C123-111.222',
      slackChannelId: 'C123',
      slackMessageTs: '111.222',
      templateId: 'tmpl-channel-task',
      templateVersion: 1,
    });
    // payload carries the channel context used by finalize to accrue + report.
    expect(data.payload).toMatchObject({
      channelId: 'chan-1',
      kind: 'channel-task',
      slackChannelId: 'C123',
      threadTs: '111.222',
    });
  });

  it('returns a repo-less request carrying channelId + the RunInput id', async () => {
    const { request, templateId, templateVersion } = await createChannelTaskRun(INPUT);

    expect(templateId).toBe('tmpl-channel-task');
    expect(templateVersion).toBe(1);
    expect(request).toMatchObject({
      channelId: 'chan-1',
      description: INPUT.description,
      externalTicketId: 'slack-C123-111.222',
      // Sentinel: Channel Task spec is repo-less.
      repoId: '',
      slackChannel: '111.222',
      workRequestId: 'runinput-1',
    });
  });

  it('throws when the Channel Task template is not seeded', async () => {
    findTemplate.mockResolvedValue(null);

    await expect(createChannelTaskRun(INPUT)).rejects.toThrow(/Channel Task/);
  });
});

describe('resolveChannelRepo', () => {
  beforeEach(() => {
    findChannel.mockResolvedValue({ teamId: 'team-1' } as never);
  });

  it('matches a repoHint by bare repoName (case-insensitive)', async () => {
    findConnections.mockResolvedValue([
      gitRepo('c-1', 'acme', 'payments-api'),
      gitRepo('c-2', 'acme', 'web'),
    ] as never);

    expect(await resolveChannelRepo('chan-1', 'Payments-API')).toEqual({ repoId: 'c-1' });
  });

  it('matches a repoHint by organizationName/repoName', async () => {
    findConnections.mockResolvedValue([
      gitRepo('c-1', 'acme', 'payments-api'),
      gitRepo('c-2', 'other', 'payments-api'),
    ] as never);

    expect(await resolveChannelRepo('chan-1', 'other/payments-api')).toEqual({ repoId: 'c-2' });
  });

  it('auto-resolves the sole repo when the team has exactly one and NO hint was given', async () => {
    findConnections.mockResolvedValue([gitRepo('c-1', 'acme', 'payments-api')] as never);

    expect(await resolveChannelRepo('chan-1')).toEqual({ repoId: 'c-1' });
  });

  it('returns null when an explicit hint does NOT match (even with a sole repo)', async () => {
    findConnections.mockResolvedValue([gitRepo('c-1', 'acme', 'payments-api')] as never);

    // A named-but-unmatched repo must NOT silently open a PR against an unrelated
    // repo — fall back to the general route instead.
    expect(await resolveChannelRepo('chan-1', 'nope')).toBeNull();
  });

  it('returns null when ambiguous: multiple repos and no matching hint', async () => {
    findConnections.mockResolvedValue([
      gitRepo('c-1', 'acme', 'payments-api'),
      gitRepo('c-2', 'acme', 'web'),
    ] as never);

    expect(await resolveChannelRepo('chan-1')).toBeNull();
    expect(await resolveChannelRepo('chan-1', 'unknown-repo')).toBeNull();
  });

  it('returns null when the team has no active git_repo connection', async () => {
    findConnections.mockResolvedValue([] as never);

    expect(await resolveChannelRepo('chan-1', 'payments-api')).toBeNull();
  });

  it('ignores git rows missing org/repo identity (guard)', async () => {
    findConnections.mockResolvedValue([
      { id: 'c-bad', organizationName: null, repoName: null, type: 'git_repo' },
      gitRepo('c-1', 'acme', 'payments-api'),
    ] as never);

    // Only the well-formed row counts → it's the sole repo → auto-resolved.
    expect(await resolveChannelRepo('chan-1')).toEqual({ repoId: 'c-1' });
  });

  it('returns null when the channel row is missing', async () => {
    findChannel.mockResolvedValue(null as never);

    expect(await resolveChannelRepo('chan-1', 'payments-api')).toBeNull();
  });
});

describe('createChannelCodeTaskRun', () => {
  const INPUT = {
    channelId: 'chan-1',
    description: 'Add a GET /health endpoint and open a PR.',
    repoHint: 'payments-api',
    slackChannelId: 'C123',
    threadTs: '111.222',
    title: 'Add health endpoint',
  };

  beforeEach(() => {
    findChannel.mockResolvedValue({ teamId: 'team-1' } as never);
    findConnections.mockResolvedValue([gitRepo('c-1', 'acme', 'payments-api')] as never);
  });

  it('builds a REAL RepoWorkRequest against the resolved repo + the default SWE template', async () => {
    const result = await createChannelCodeTaskRun(INPUT);

    expect(result).not.toBeNull();
    // Default SWE template resolved via resolveTemplateForRepo(resolvedRepoId).
    expect(resolveTemplate).toHaveBeenCalledWith('c-1');
    expect(result?.templateId).toBe('tmpl-swe');
    expect(result?.templateVersion).toBe(3);
    // Shares the deterministic per-thread workflowId with the general route.
    expect(result?.workflowId).toBe('chantask-chan-1-111-222');
    expect(result?.request).toMatchObject({
      channelId: 'chan-1',
      description: INPUT.description,
      externalTicketId: 'slack-C123-111.222',
      // Real repo (NOT the repo-less sentinel) — the SWE spec needs a workspace.
      repoId: 'c-1',
      slackChannel: '111.222',
      workRequestId: 'runinput-1',
    });
  });

  it("stamps payload.kind='channel-task' so finalize accrues to the channel + reports back", async () => {
    await createChannelCodeTaskRun(INPUT);

    const data = createRunInput.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      // Links the resolved git_repo Connection so finalize can derive the org and
      // bill OrgMonthlyUsage / enforce the org budget cap (like a normal request).
      connectionId: 'c-1',
      slackChannelId: 'C123',
      slackMessageTs: '111.222',
      templateId: 'tmpl-swe',
      templateVersion: 3,
    });
    expect(data.payload).toMatchObject({
      channelId: 'chan-1',
      kind: 'channel-task',
      repoId: 'c-1',
    });
  });

  it('returns null (fall back to general) when no repo resolves', async () => {
    findConnections.mockResolvedValue([
      gitRepo('c-1', 'acme', 'payments-api'),
      gitRepo('c-2', 'acme', 'web'),
    ] as never);

    // Ambiguous (two repos) + an unmatched hint → null.
    expect(await createChannelCodeTaskRun({ ...INPUT, repoHint: 'nope' })).toBeNull();
    // No template resolution / RunInput insert on the null path.
    expect(resolveTemplate).not.toHaveBeenCalled();
    expect(createRunInput).not.toHaveBeenCalled();
  });
});

describe('isChannelOverBudgetForTask', () => {
  it('returns false (fast path) when the channel has no cap', async () => {
    findChannel.mockResolvedValue({ monthlyBudgetUsdCents: null } as never);

    expect(await isChannelOverBudgetForTask('chan-1')).toBe(false);
    // No-cap fast path: never reads the usage row.
    expect(findUsage).not.toHaveBeenCalled();
  });

  it('returns true when month-to-date spend has reached the cap', async () => {
    findChannel.mockResolvedValue({ monthlyBudgetUsdCents: 500 } as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 5 } as never);

    expect(await isChannelOverBudgetForTask('chan-1')).toBe(true);
  });

  it('returns false when month-to-date spend is under the cap', async () => {
    findChannel.mockResolvedValue({ monthlyBudgetUsdCents: 500 } as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 4.99 } as never);

    expect(await isChannelOverBudgetForTask('chan-1')).toBe(false);
  });
});
