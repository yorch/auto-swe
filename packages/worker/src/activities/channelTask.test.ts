import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
    channelMonthlyUsage: { findUnique: vi.fn() },
    runInput: { create: vi.fn() },
    slackChannel: { findUnique: vi.fn() },
    workflowTemplate: { findFirst: vi.fn() },
  };
  return { prisma: prismaMock };
});

vi.mock('@auto-swe/shared/lib/billing', () => ({
  currentYearMonth: vi.fn().mockReturnValue('2026-06'),
}));

import { prisma } from '@auto-swe/shared/db';
import { createChannelTaskRun, isChannelOverBudgetForTask } from './channelTask.js';

const findTemplate = vi.mocked(prisma.workflowTemplate.findFirst);
const createRunInput = vi.mocked(prisma.runInput.create);
const findChannel = vi.mocked(prisma.slackChannel.findUnique);
const findUsage = vi.mocked(prisma.channelMonthlyUsage.findUnique);

beforeEach(() => {
  vi.clearAllMocks();
  findTemplate.mockResolvedValue({ activeVersion: 1, id: 'tmpl-channel-task' } as never);
  createRunInput.mockResolvedValue({ id: 'runinput-1' } as never);
});

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
