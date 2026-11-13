import { describe, expect, it, vi } from 'vitest';
import { latestRunIdForWorkRequest, runProvenance } from './runProvenance.js';

describe('runProvenance', () => {
  it('names the door and the person, and nothing else', () => {
    expect(runProvenance({ actor: { sub: 'user-1' }, trigger: 'work-request' })).toEqual({
      initiatedById: 'user-1',
      trigger: 'work-request',
    });
  });

  it('names the service principal and no person', () => {
    expect(runProvenance({ actor: null, serviceId: 'sp-1', trigger: 'service-token' })).toEqual({
      initiatedByServiceId: 'sp-1',
      trigger: 'service-token',
    });
  });

  it('carries the reference and the repeated run when given', () => {
    expect(
      runProvenance({
        actor: { sub: 'user-1' },
        rerunOfRunId: 'run-1',
        trigger: 'template-retry',
        triggerRefId: 'ref-1',
      })
    ).toEqual({
      initiatedById: 'user-1',
      rerunOfRunId: 'run-1',
      trigger: 'template-retry',
      triggerRefId: 'ref-1',
    });
  });

  it('leaves off every key with no value, so a webhook carries only its door', () => {
    expect(runProvenance({ trigger: 'webhook' })).toEqual({ trigger: 'webhook' });
    expect(
      runProvenance({
        actor: null,
        rerunOfRunId: undefined,
        serviceId: null,
        trigger: 'automation',
        triggerRefId: null,
      })
    ).toEqual({ trigger: 'automation' });
  });
});

describe('latestRunIdForWorkRequest', () => {
  it('reads the newest WorkflowRun id of the work request', async () => {
    const findFirst = vi.fn(async (_args: unknown) => ({ id: 'run-9' }));
    const prisma = { workflowRun: { findFirst } } as unknown as Parameters<
      typeof latestRunIdForWorkRequest
    >[0];
    expect(await latestRunIdForWorkRequest(prisma, 'wr-1')).toBe('run-9');
    expect(findFirst).toHaveBeenCalledWith({
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
      where: { workRequestId: 'wr-1' },
    });
  });

  it('is undefined when the request has no run row yet', async () => {
    const prisma = {
      workflowRun: { findFirst: vi.fn(async () => null) },
    } as unknown as Parameters<typeof latestRunIdForWorkRequest>[0];
    expect(await latestRunIdForWorkRequest(prisma, 'wr-1')).toBeUndefined();
  });

  it('returns undefined and logs when the lookup fails, so a retry is not failed by it', async () => {
    const err = new Error('db down');
    const prisma = {
      workflowRun: {
        findFirst: vi.fn(async () => {
          throw err;
        }),
      },
    } as unknown as Parameters<typeof latestRunIdForWorkRequest>[0];
    const log = { warn: vi.fn() };
    expect(await latestRunIdForWorkRequest(prisma, 'wr-1', log)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err, workRequestId: 'wr-1' }),
      expect.any(String)
    );
    // No logger given: still swallowed.
    expect(await latestRunIdForWorkRequest(prisma, 'wr-1')).toBeUndefined();
  });
});
