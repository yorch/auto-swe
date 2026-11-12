import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ updateMany: vi.fn(), upsert: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { repoSetupBlocker: db } }));
vi.mock('./activityContext.js', () => ({ currentWorkflowId: () => 'workflow' }));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));

import { logWarn } from './activityLog.js';
import { recordSetupFailure, resolveSetupBlockers } from './setupBlockerRecorder.js';

const blocker = { detail: 'missing TOKEN', kind: 'missing_secret', subject: 'TOKEN' };
beforeEach(() => vi.resetAllMocks());

describe('setup blocker recorder', () => {
  it('upserts by repository, kind and subject and reopens/increments a repeated blocker', async () => {
    await recordSetupFailure('repo', { details: [blocker] });
    expect(db.upsert).toHaveBeenCalledWith({
      create: {
        connectionId: 'repo',
        ...blocker,
        firstSeenAt: expect.any(Date),
        lastSeenAt: expect.any(Date),
        lastWorkflowId: 'workflow',
        occurrences: 1,
      },
      update: {
        ...blocker,
        lastSeenAt: expect.any(Date),
        lastWorkflowId: 'workflow',
        occurrences: { increment: 1 },
        resolvedAt: null,
        step: null,
      },
      where: {
        connectionId_kind_subject: {
          connectionId: 'repo',
          kind: 'missing_secret',
          subject: 'TOKEN',
        },
      },
    });
  });

  it.each([null, new Error('ordinary'), { details: [] }, { details: [{ kind: 'unknown' }] }])(
    'ignores errors without valid blocker details',
    async (error) => {
      await recordSetupFailure('repo', error);
      expect(db.upsert).not.toHaveBeenCalled();
    }
  );

  it('resolves only open blockers on the successful repository', async () => {
    await resolveSetupBlockers('repo');
    expect(db.updateMany).toHaveBeenCalledWith({
      data: { resolvedAt: expect.any(Date) },
      where: { connectionId: 'repo', resolvedAt: null },
    });
  });

  it('logs persistence errors without throwing', async () => {
    db.upsert.mockRejectedValueOnce(new Error('db unavailable'));
    db.updateMany.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(recordSetupFailure('repo', { details: [blocker] })).resolves.toBeUndefined();
    await expect(resolveSetupBlockers('repo')).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledTimes(2);
  });
});
