import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    organization: { findUnique: vi.fn() },
    reviewLaunchIntent: {
      createMany: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    reviewPresetAttachment: { findMany: vi.fn() },
    workflowRun: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  },
  prepare: vi.fn(),
  record: vi.fn(),
  setting: vi.fn(),
  start: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: mocks.db }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: mocks.setting }));
vi.mock('@auto-swe/shared/lib/reviewLaunch', async (original) => ({
  ...(await original<object>()),
  prepareReviewLaunch: mocks.prepare,
  recordReviewLaunch: mocks.record,
}));
vi.mock('../lib/temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { start: mocks.start } }),
}));
vi.mock('../lib/execUtils.js', () => ({
  withHeartbeat: (_label: string, promise: Promise<unknown>) => promise,
}));
vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));
vi.mock('../lib/launchAudit.js', () => ({ recordWorkerLaunchAudit: vi.fn() }));

import type { Prisma } from '@auto-swe/shared';
import { ReviewLaunchError } from '@auto-swe/shared/lib/reviewLaunch';
import {
  dispatchReviewLaunches,
  enqueueReviewLaunchIntents,
  sweepReviewLaunches,
} from './reviewLaunches.js';

const source = {
  connectionId: 'repo',
  id: 'source',
  orgId: 'org',
  reviewOfRunId: null,
  teamId: 'team',
  templateId: 'template',
  templateKind: null,
};
const intent = {
  attempts: 0,
  id: 'abcdefff-1111-4111-8111-111111111111',
  presetId: 'preset',
  status: 'pending',
  updatedAt: new Date(0),
};
const tx = mocks.db as unknown as Prisma.TransactionClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.setting.mockResolvedValue(true);
  mocks.db.reviewPresetAttachment.findMany.mockResolvedValue([
    { presetId: 'p' },
    { presetId: 'p' },
  ]);
  mocks.db.reviewLaunchIntent.findMany.mockResolvedValue([intent]);
  mocks.db.reviewLaunchIntent.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.workflowRun.findUniqueOrThrow.mockResolvedValue({ launchedById: 'launcher' });
  mocks.db.workflowRun.findUnique.mockResolvedValue({ id: 'review-run' });
  mocks.db.organization.findUnique.mockResolvedValue(null);
  mocks.prepare.mockResolvedValue({
    repo: { team: { orgId: 'org' } },
    request: { workRequestId: 'input' },
    workflowId: 'review-repo-abcdefff',
  });
  mocks.record.mockResolvedValue({
    request: { launchedById: 'launcher' },
    templateId: 'template',
    templateVersion: 1,
  });
  mocks.start.mockResolvedValue(undefined);
});

describe('finalization review intents', () => {
  it('selects enabled presets matching either source template or repository and deduplicates within the terminal transaction', async () => {
    await enqueueReviewLaunchIntents(tx, source, 'SUCCESS');
    expect(mocks.db.reviewPresetAttachment.findMany).toHaveBeenCalledWith({
      select: { presetId: true },
      where: {
        OR: [{ templateId: 'template' }, { connectionId: 'repo' }],
        preset: { enabled: true },
      },
    });
    expect(mocks.db.reviewLaunchIntent.createMany).toHaveBeenCalledWith({
      data: [{ presetId: 'p', sourceRunId: 'source' }],
      skipDuplicates: true,
    });
  });
  it.each(['CANCELLED', 'FAILED', 'SKIPPED', 'TIMED_OUT'])(
    'never inserts for effective %s status',
    async (status) => {
      await enqueueReviewLaunchIntents(tx, source, status);
      expect(mocks.db.reviewLaunchIntent.createMany).not.toHaveBeenCalled();
    }
  );
  it('skips reviews of reviews, disabled scopes and empty attachments', async () => {
    await enqueueReviewLaunchIntents(tx, { ...source, templateKind: 'review' }, 'SUCCESS');
    await enqueueReviewLaunchIntents(tx, { ...source, reviewOfRunId: 'original' }, 'SUCCESS');
    mocks.setting.mockResolvedValue(false);
    await enqueueReviewLaunchIntents(tx, source, 'SUCCESS');
    mocks.setting.mockResolvedValue(true);
    mocks.db.reviewPresetAttachment.findMany.mockResolvedValue([]);
    await enqueueReviewLaunchIntents(tx, source, 'SUCCESS');
    expect(mocks.db.reviewLaunchIntent.createMany).not.toHaveBeenCalled();
  });
  it('still queues template attachments for repo-less sources, for the dispatcher to classify', async () => {
    await enqueueReviewLaunchIntents(
      tx,
      { ...source, connectionId: null, orgId: undefined, teamId: undefined },
      'SUCCESS'
    );
    expect(mocks.db.reviewPresetAttachment.findMany).toHaveBeenCalledWith({
      select: { presetId: true },
      where: { OR: [{ templateId: 'template' }], preset: { enabled: true } },
    });
    expect(mocks.db.reviewLaunchIntent.createMany).toHaveBeenCalledOnce();
  });
  it('propagates insertion failure so terminal bookkeeping rolls back', async () => {
    mocks.db.reviewLaunchIntent.createMany.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(enqueueReviewLaunchIntents(tx, source, 'SUCCESS')).rejects.toThrow(
      'database unavailable'
    );
  });
});

describe('review dispatcher and fallback', () => {
  it('claims a pending intent, propagates the source launcher, records before starting, and marks started', async () => {
    await dispatchReviewLaunches('source');
    expect(mocks.db.reviewLaunchIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempts: { increment: 1 } }),
        where: { attempts: 0, id: intent.id, status: 'pending', updatedAt: intent.updatedAt },
      })
    );
    expect(mocks.prepare).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({
        launchedById: 'launcher',
        presetId: 'preset',
        sourceRunId: 'source',
      })
    );
    expect(mocks.record.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.db.reviewLaunchIntent.update).toHaveBeenCalledWith({
      data: { reason: null, reviewRunId: 'review-run', status: 'started' },
      where: { id: intent.id },
    });
  });
  it('does not launch when another dispatcher wins the claim', async () => {
    mocks.db.reviewLaunchIntent.updateMany.mockResolvedValue({ count: 0 });
    await dispatchReviewLaunches('source');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('skips non-reviewable sources but records unexpected start failures', async () => {
    mocks.prepare.mockRejectedValueOnce(new ReviewLaunchError('REVIEW_NOTHING_TO_REVIEW', 'empty'));
    await dispatchReviewLaunches('source');
    expect(mocks.db.reviewLaunchIntent.update).toHaveBeenLastCalledWith({
      data: { reason: 'REVIEW_NOTHING_TO_REVIEW', status: 'skipped' },
      where: { id: intent.id },
    });
    mocks.start.mockRejectedValueOnce(new Error('Temporal unavailable'));
    await dispatchReviewLaunches('source');
    expect(mocks.db.reviewLaunchIntent.update).toHaveBeenLastCalledWith({
      data: { reason: 'REVIEW_LAUNCH_FAILED', status: 'failed' },
      where: { id: intent.id },
    });
  });
  it('adopts duplicate Temporal starts and tolerates run-row creation lag', async () => {
    const duplicate = new Error('already started');
    duplicate.name = 'WorkflowExecutionAlreadyStartedError';
    mocks.start.mockRejectedValueOnce(duplicate);
    mocks.db.workflowRun.findUnique.mockResolvedValue(null);
    await dispatchReviewLaunches('source');
    expect(mocks.db.reviewLaunchIntent.update).toHaveBeenCalledWith({
      data: { reason: null, status: 'started' },
      where: { id: intent.id },
    });
  });
  it('handles empty queues without attempting a start', async () => {
    mocks.db.reviewLaunchIntent.findMany.mockResolvedValue([]);
    await dispatchReviewLaunches('source');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('recovers stale pending and failed intents from the existing reaper', async () => {
    mocks.db.reviewLaunchIntent.findMany
      .mockResolvedValueOnce([{ sourceRunId: 'source' }])
      .mockResolvedValueOnce([intent]);
    await sweepReviewLaunches(new Date('2026-01-01Z'));
    expect(mocks.db.reviewLaunchIntent.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        attempts: { lt: 3 },
        status: { in: ['pending', 'failed'] },
        updatedAt: { lt: new Date('2025-12-31T23:55:00Z') },
      },
    });
    expect(mocks.start).toHaveBeenCalledOnce();
  });
});
