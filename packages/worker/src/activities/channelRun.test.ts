import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    agentTrace: { aggregate: vi.fn() },
    channelThreadSession: { deleteMany: vi.fn(), upsert: vi.fn() },
    slackChannel: { findUnique: vi.fn() },
    workflowRun: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    workflowTemplate: { findFirst: vi.fn() },
  };
  return { prisma: prismaMock };
});

// A minimal stand-in for Prisma.PrismaClientKnownRequestError so the P2002
// idempotency branch can be exercised without the generated client. Defined via
// vi.hoisted so it's available inside the (hoisted) vi.mock factory below.
const { FakePrismaError } = vi.hoisted(() => {
  class FakePrismaError extends Error {
    code: string;
    constructor(code: string) {
      super(`prisma error ${code}`);
      this.code = code;
    }
  }
  return { FakePrismaError };
});
vi.mock('@auto-swe/shared', () => ({
  Prisma: { PrismaClientKnownRequestError: FakePrismaError },
}));

import { prisma } from '@auto-swe/shared/db';
import { finalizeChannelRun, startChannelRun, touchChannelThreadSession } from './channelRun.js';

// biome-ignore lint/suspicious/noExplicitAny: terse access to the mocked prisma client in tests.
const p = prisma as any;

const TEMPLATE = { activeVersion: 1, id: 'tmpl-channel' };

beforeEach(() => {
  vi.clearAllMocks();
  p.workflowTemplate.findFirst.mockResolvedValue(TEMPLATE);
  p.slackChannel.findUnique.mockResolvedValue({ orgId: 'org-1', teamId: 'team-1' });
});

describe('startChannelRun', () => {
  it('creates a RUNNING run keyed to the Temporal workflowId with the channel metadata', async () => {
    await startChannelRun({
      channelId: 'chan-1',
      kind: 'mention',
      label: 'C12345',
      orgId: 'org-1',
      teamId: 'team-1',
      workflowId: 'channel-assistant-abc',
    });

    expect(p.workflowRun.create).toHaveBeenCalledTimes(1);
    const data = p.workflowRun.create.mock.calls[0][0].data;
    expect(data.workflowId).toBe('channel-assistant-abc');
    expect(data.status).toBe('RUNNING');
    expect(data.templateId).toBe('tmpl-channel');
    expect(data.templateVersion).toBe(1);
    expect(data.workRequestId).toBeNull();
    // Channel metadata rides along in the spec snapshot (no schema column).
    expect(data.specSnapshot.channel).toMatchObject({
      channelId: 'chan-1',
      kind: 'mention',
      label: 'C12345',
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  it('backfills team/org from the channel row when not supplied (ambient path)', async () => {
    await startChannelRun({
      channelId: 'chan-1',
      kind: 'ambient',
      label: 'chan-1',
      workflowId: 'channel-ambient-xyz',
    });

    expect(p.slackChannel.findUnique).toHaveBeenCalledTimes(1);
    const data = p.workflowRun.create.mock.calls[0][0].data;
    expect(data.specSnapshot.channel).toMatchObject({ orgId: 'org-1', teamId: 'team-1' });
  });

  it('is idempotent: a P2002 unique-constraint violation is swallowed (no throw)', async () => {
    p.workflowRun.create.mockRejectedValueOnce(new FakePrismaError('P2002'));
    await expect(
      startChannelRun({
        channelId: 'chan-1',
        kind: 'mention',
        label: 'C1',
        orgId: 'org-1',
        teamId: 'team-1',
        workflowId: 'dup',
      })
    ).resolves.toBeUndefined();
  });

  it('rethrows non-P2002 prisma errors', async () => {
    p.workflowRun.create.mockRejectedValueOnce(new FakePrismaError('P2003'));
    await expect(
      startChannelRun({
        channelId: 'chan-1',
        kind: 'mention',
        label: 'C1',
        orgId: 'org-1',
        teamId: 'team-1',
        workflowId: 'boom',
      })
    ).rejects.toThrow('prisma error P2003');
  });

  it('throws when the Channel Assistant template is not seeded', async () => {
    p.workflowTemplate.findFirst.mockResolvedValueOnce(null);
    await expect(
      startChannelRun({
        channelId: 'chan-1',
        kind: 'mention',
        label: 'C1',
        orgId: 'org-1',
        teamId: 'team-1',
        workflowId: 'w',
      })
    ).rejects.toThrow(/Channel Assistant.*workflow template/);
    expect(p.workflowRun.create).not.toHaveBeenCalled();
  });
});

describe('finalizeChannelRun', () => {
  it('sets status + endedAt and denormalizes cost/tokens summed from the run traces', async () => {
    p.workflowRun.findUnique.mockResolvedValue({ id: 'run-1' });
    p.agentTrace.aggregate.mockResolvedValue({
      _sum: { costUsd: 0.0123, inputTokens: 4200, outputTokens: 900 },
    });

    await finalizeChannelRun({ status: 'SUCCESS', workflowId: 'channel-assistant-abc' });

    expect(p.agentTrace.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: 'run-1' } })
    );
    expect(p.workflowRun.update).toHaveBeenCalledTimes(1);
    const call = p.workflowRun.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'run-1' });
    expect(call.data.status).toBe('SUCCESS');
    expect(call.data.costUsdAccrued).toBe(0.0123);
    expect(call.data.tokensInputTotal).toBe(4200);
    expect(call.data.tokensOutputTotal).toBe(900);
    expect(call.data.endedAt).toBeInstanceOf(Date);
  });

  it('treats null trace sums as zero (no traces persisted)', async () => {
    p.workflowRun.findUnique.mockResolvedValue({ id: 'run-2' });
    p.agentTrace.aggregate.mockResolvedValue({
      _sum: { costUsd: null, inputTokens: null, outputTokens: null },
    });

    await finalizeChannelRun({ status: 'FAILED', workflowId: 'w' });

    const call = p.workflowRun.update.mock.calls[0][0];
    expect(call.data.status).toBe('FAILED');
    expect(call.data.costUsdAccrued).toBe(0);
    expect(call.data.tokensInputTotal).toBe(0);
    expect(call.data.tokensOutputTotal).toBe(0);
  });

  it('is a no-op when the run row is missing', async () => {
    p.workflowRun.findUnique.mockResolvedValue(null);

    await finalizeChannelRun({ status: 'SUCCESS', workflowId: 'missing' });

    expect(p.agentTrace.aggregate).not.toHaveBeenCalled();
    expect(p.workflowRun.update).not.toHaveBeenCalled();
  });
});

describe('touchChannelThreadSession (Gap H)', () => {
  const origRandom = Math.random;
  beforeEach(() => {
    p.channelThreadSession.upsert.mockResolvedValue({});
    p.channelThreadSession.deleteMany.mockResolvedValue({ count: 0 });
  });
  afterEach(() => {
    Math.random = origRandom;
  });

  it('upserts the (channelId, threadTs) session bumping lastAssistantAt', async () => {
    Math.random = () => 0.99; // skip the sweep this run
    await touchChannelThreadSession({ channelId: 'chan-1', threadTs: '1700.1' });

    expect(p.channelThreadSession.upsert).toHaveBeenCalledTimes(1);
    const call = p.channelThreadSession.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      channelId_threadTs: { channelId: 'chan-1', threadTs: '1700.1' },
    });
    expect(call.update).toHaveProperty('lastAssistantAt');
    // Sweep skipped when the probability roll misses.
    expect(p.channelThreadSession.deleteMany).not.toHaveBeenCalled();
  });

  it('sweeps stale rows for the channel when the probability roll hits', async () => {
    Math.random = () => 0; // force the sweep
    await touchChannelThreadSession({ channelId: 'chan-1', threadTs: '1700.2' });

    expect(p.channelThreadSession.deleteMany).toHaveBeenCalledTimes(1);
    const sweep = p.channelThreadSession.deleteMany.mock.calls[0][0];
    expect(sweep.where.channelId).toBe('chan-1');
    // Only rows OLDER than the retention window are deleted (live sessions kept).
    expect(sweep.where.lastAssistantAt).toHaveProperty('lt');
  });

  it('never throws when the upsert fails (best-effort)', async () => {
    Math.random = () => 0;
    p.channelThreadSession.upsert.mockRejectedValue(new Error('db down'));
    await expect(
      touchChannelThreadSession({ channelId: 'chan-1', threadTs: '1700.3' })
    ).resolves.toBeUndefined();
  });
});
