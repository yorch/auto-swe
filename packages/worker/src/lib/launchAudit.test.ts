import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prisma = {
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    configAuditLog: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
  };
  return { prisma };
});
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));

import { prisma } from '@auto-swe/shared/db';
import { logWarn } from './activityLog.js';
import { recordWorkerLaunchAudit } from './launchAudit.js';

const create = vi.mocked(prisma.configAuditLog.create);
const find = vi.mocked(prisma.configAuditLog.findFirst);

const AUDIT = {
  actorId: 'user-1',
  details: { workRequestId: 'wr-1' },
  entityId: 'run-1',
  entityType: 'WorkflowRun',
  source: 'epic-child',
} as const;

describe('recordWorkerLaunchAudit', () => {
  beforeEach(() => {
    create.mockClear();
    vi.mocked(prisma.$transaction).mockClear();
    find.mockReset().mockResolvedValue(null);
    vi.mocked(logWarn).mockClear();
  });

  it('writes a CREATE row with the source in afterJson and no context', async () => {
    await recordWorkerLaunchAudit(AUDIT);
    expect(create).toHaveBeenCalledWith({
      data: {
        action: 'CREATE',
        actorId: 'user-1',
        afterJson: { source: 'epic-child', workRequestId: 'wr-1' },
        entityId: 'run-1',
        entityType: 'WorkflowRun',
      },
    });
  });

  it('takes the entity lock inside the transaction before it looks for an existing row', async () => {
    const order: string[] = [];
    vi.mocked(prisma.$executeRaw).mockImplementationOnce((async () => {
      order.push('lock');
      return 1;
    }) as never);
    find.mockImplementationOnce((async () => {
      order.push('find');
      return null;
    }) as never);
    await recordWorkerLaunchAudit(AUDIT);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['lock', 'find']);
  });

  it('cannot have its source overridden by a detail', async () => {
    await recordWorkerLaunchAudit({
      ...AUDIT,
      details: { source: 'forged', workRequestId: 'wr-1' },
    });
    expect(create.mock.calls[0]?.[0].data.afterJson).toEqual({
      source: 'epic-child',
      workRequestId: 'wr-1',
    });
  });

  it('uses a null actor when no launcher is known', async () => {
    await recordWorkerLaunchAudit({ ...AUDIT, actorId: undefined });
    expect(create.mock.calls[0]?.[0].data.actorId).toBeNull();
  });

  it('writes nothing when the entity already carries a launch row from that source', async () => {
    find.mockResolvedValue({ id: 'a' } as never);
    await recordWorkerLaunchAudit(AUDIT);
    expect(create).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed write', async () => {
    create.mockRejectedValueOnce(new Error('db down'));
    await expect(recordWorkerLaunchAudit(AUDIT)).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalled();
  });

  it('logs and swallows a failed dedupe read', async () => {
    find.mockRejectedValueOnce(new Error('db down'));
    await expect(recordWorkerLaunchAudit(AUDIT)).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });
});
