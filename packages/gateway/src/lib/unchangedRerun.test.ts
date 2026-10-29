import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWorkflowRunVisibilityFilter } from './runVisibility.js';
import {
  clearStopNodeCache,
  fingerprintRequest,
  NOT_ACTIONABLE_RERUN_WINDOW_MS,
  refuseUnchangedRerun,
  UNCHANGED_AFTER_NOT_ACTIONABLE,
} from './unchangedRerun.js';

const NOW = 1_000_000_000_000;
const identity = {
  description: 'Fix   the login\nbug',
  payload: { budget: 'STANDARD', connectionId: 'repo-1', ticketId: 'proj-1' },
  templateId: 'template-1',
  templateVersion: 2,
};
const stoppedAt = new Date(NOW - 60_000);
const previous = {
  id: 'run-previous',
  startedAt: stoppedAt,
  workRequest: {
    description: 'Fix the login bug',
    payload: { budget: 'STANDARD', connectionId: 'repo-1', ticketId: 'PROJ-1' },
  },
  workRequestId: 'wr-1',
};
const laterRun = (over: Record<string, unknown> = {}) => ({
  workRequest: previous.workRequest,
  workRequestId: 'wr-2',
  ...over,
});
const user = { role: 'ENGINEER', sub: 'user-1' };
const stopSpec = { nodes: { terminateNotActionable: { status: 'FAILED', type: 'terminate' } } };

beforeEach(() => clearStopNodeCache());

/** `later` is what the second lookup (runs after the stop) returns. */
function harness(stops: unknown[] | Error, later: unknown[] = [], spec: unknown = stopSpec) {
  const reply = { send: vi.fn(() => reply), status: vi.fn(() => reply) };
  const findMany = vi.fn(async (_query: unknown) => {
    if (stops instanceof Error) {
      throw stops;
    }
    return findMany.mock.calls.length === 1 ? stops : later;
  });
  const findVersion = vi.fn(async (_query: unknown) => ({ spec }));
  const log = { warn: vi.fn() };
  const call = (
    over: Partial<Parameters<typeof refuseUnchangedRerun>[1]> = {},
    acknowledged?: boolean
  ) =>
    refuseUnchangedRerun(
      {
        gate: undefined,
        log,
        now: () => NOW,
        prisma: {
          workflowRun: { findMany },
          workflowTemplateVersion: { findFirst: findVersion },
        } as never,
        user,
      },
      { ...identity, ...over },
      reply as never,
      acknowledged
    );
  return { call, findMany, findVersion, log, reply };
}

describe('fingerprintRequest', () => {
  it('ignores whitespace, and the case of the ticket id, only', () => {
    const a = fingerprintRequest(identity.description, identity.payload);
    expect(
      fingerprintRequest(' Fix the login bug ', { ...identity.payload, ticketId: 'PROJ-1' })
    ).toBe(a);
    expect(fingerprintRequest('fix the login bug', identity.payload)).not.toBe(a);
    expect(
      fingerprintRequest(identity.description, { ...identity.payload, budget: 'LARGE' })
    ).not.toBe(a);
    expect(
      fingerprintRequest(identity.description, { ...identity.payload, connectionId: 'repo-2' })
    ).not.toBe(a);
  });

  it('does not depend on key order', () => {
    const forward: Record<string, unknown> = {};
    forward.a = 1;
    forward.b = { c: 2, d: 3 };
    const backward: Record<string, unknown> = {};
    backward.b = { c: 2, d: 3 };
    backward.a = 1;
    expect(Object.keys(forward)).not.toEqual(Object.keys(backward));
    expect(fingerprintRequest('x', forward)).toBe(fingerprintRequest('x', backward));
  });
});

describe('refuseUnchangedRerun', () => {
  it('refuses with 409 naming the earlier run when the request stopped as not actionable', async () => {
    const { call, reply } = harness([previous]);
    expect(await call()).toBe(true);
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: UNCHANGED_AFTER_NOT_ACTIONABLE,
        details: { previousRunId: 'run-previous', stoppedAt: stoppedAt.toISOString() },
        message: expect.stringContaining('run-previous'),
      }),
    });
    // The in-app assistant reads this text; the override's name is not in it.
    const sent = reply.send.mock.calls[0] as unknown as [{ error: { message: string } }];
    expect(sent[0].error.message).not.toContain('acknowledgeUnchanged');
  });

  it('asks the database for exactly the failed stops of this request, version and window', async () => {
    const { call, findMany } = harness([]);
    await call();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual({
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        workRequest: { select: { description: true, payload: true } },
        workRequestId: true,
      },
      take: 25,
      where: {
        AND: [
          buildWorkflowRunVisibilityFilter(user, undefined),
          {
            startedAt: { gte: new Date(NOW - NOT_ACTIONABLE_RERUN_WINDOW_MS) },
            status: 'FAILED',
            templateId: 'template-1',
            templateVersion: 2,
            workRequest: {
              connectionId: 'repo-1',
              externalTicketId: { equals: 'proj-1', mode: 'insensitive' },
            },
          },
          {
            contextSnapshot: { equals: false, path: ['nodes', 'validate', 'output', 'actionable'] },
            specSnapshot: {
              equals: 'terminate',
              path: ['nodes', 'terminateNotActionable', 'type'],
            },
          },
        ],
      },
    });
  });

  it('looks for later runs of the template and request, through the visibility filter', async () => {
    const { call, findMany } = harness([previous]);
    await call();
    expect(findMany.mock.calls[1][0]).toEqual({
      orderBy: { startedAt: 'desc' },
      select: {
        workRequest: { select: { description: true, payload: true } },
        workRequestId: true,
      },
      take: 25,
      where: {
        AND: [
          buildWorkflowRunVisibilityFilter(user, undefined),
          {
            OR: [
              { workRequestId: 'wr-1' },
              {
                workRequest: {
                  description: { in: [identity.description, previous.workRequest.description] },
                },
              },
            ],
            startedAt: { gt: stoppedAt },
            templateId: 'template-1',
            workRequest: {
              connectionId: 'repo-1',
              externalTicketId: { equals: 'proj-1', mode: 'insensitive' },
            },
          },
        ],
      },
    });
  });

  it('omits the repository and ticket narrowing a request does not carry', async () => {
    const { call, findMany } = harness([]);
    await call({ payload: { description: 'x' } });
    const where = (findMany.mock.calls[0][0] as { where: { AND: Record<string, unknown>[] } })
      .where;
    expect(where.AND[1]).toMatchObject({ workRequest: {} });
    expect(where.AND[1]).not.toHaveProperty('workRequest.connectionId');
  });

  it('launches when the request differs in description, ticket, repository or inputs', async () => {
    for (const over of [
      { description: 'Fix the login bug, and add tests' },
      { payload: { ...identity.payload, ticketId: 'PROJ-2' } },
      { payload: { ...identity.payload, connectionId: 'repo-2' } },
      { payload: { ...identity.payload, budget: 'EPIC' } },
    ]) {
      const { call, reply } = harness([previous]);
      expect(await call(over)).toBe(false);
      expect(reply.status).not.toHaveBeenCalled();
    }
  });

  it('launches when nothing identical stopped', async () => {
    const { call, reply } = harness([]);
    expect(await call()).toBe(false);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('launches when a later run of the same request exists, whatever its outcome', async () => {
    const { call, reply } = harness([previous], [laterRun()]);
    expect(await call()).toBe(false);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('launches when a later run belongs to the same work request, even with other text', async () => {
    const { call } = harness(
      [previous],
      [laterRun({ workRequest: { description: 'other', payload: {} }, workRequestId: 'wr-1' })]
    );
    expect(await call()).toBe(false);
  });

  it('still refuses when the later runs are of other requests', async () => {
    const { call } = harness(
      [previous],
      [laterRun({ workRequest: { description: 'other', payload: {} } })]
    );
    expect(await call()).toBe(true);
  });

  it('cites the newest stop when a later run stopped too', async () => {
    const newer = { ...previous, id: 'run-newer', startedAt: new Date(NOW - 1_000) };
    const { call, reply } = harness([newer, previous]);
    expect(await call()).toBe(true);
    expect(reply.send).toHaveBeenCalledWith({
      error: expect.objectContaining({
        details: expect.objectContaining({ previousRunId: 'run-newer' }),
      }),
    });
  });

  it('skips the lookup when the version cannot stop as not actionable, and remembers it', async () => {
    const { call, findMany, findVersion } = harness([previous], [], { nodes: {} });
    expect(await call()).toBe(false);
    expect(await call()).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
    expect(findVersion).toHaveBeenCalledTimes(1);
  });

  it('launches without asking when the caller acknowledges the request', async () => {
    const { call, findMany, reply } = harness([previous]);
    expect(await call({}, true)).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('launches, and logs, when the check itself fails', async () => {
    const { call, log, reply } = harness(new Error('connection reset'));
    expect(await call()).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('skips the check for a caller that is not a user, since it has no visibility filter', async () => {
    const { findMany, reply } = harness([previous]);
    const refused = await refuseUnchangedRerun(
      {
        gate: undefined,
        log: { warn: vi.fn() },
        prisma: { workflowRun: { findMany } } as never,
        user: null,
      },
      identity,
      reply as never,
      undefined
    );
    expect(refused).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });
});
