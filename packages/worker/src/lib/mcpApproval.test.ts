import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  orchestrationId: string;
  callKey: string;
  childId: string | null;
  runId: string | null;
  connectionId: string;
  toolName: string;
  argumentsDigest: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';
  expiresAt: Date;
  decidedAt: Date | null;
  outcome: unknown;
};

const h = vi.hoisted(() => {
  const state = {
    approvals: [] as Row[],
    failReads: false,
    messages: [] as Array<{ data: Record<string, unknown> }>,
    nextId: 1,
    orchestration: null as null | {
      connectionIds: string[];
      launchedById: string | null;
      teamId: string;
    },
    raceOnFirstCreate: false,
    runOrchestrationId: 'orch-1' as string | null,
  };
  return {
    beat: vi.fn(),
    log: vi.fn(),
    state,
    timeout: vi.fn(async () => 600),
  };
});

vi.mock('@temporalio/activity', () => ({ heartbeat: h.beat }));
vi.mock('./activityLog.js', () => ({ logWarn: h.log }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: h.timeout }));
vi.mock('@auto-swe/shared/db', () => {
  const s = h.state;
  const approval = {
    create: async ({ data }: { data: Omit<Row, 'id' | 'status' | 'outcome' | 'decidedAt'> }) => {
      if (
        s.raceOnFirstCreate ||
        s.approvals.some(
          (a) => a.orchestrationId === data.orchestrationId && a.callKey === data.callKey
        )
      ) {
        if (s.raceOnFirstCreate) {
          s.raceOnFirstCreate = false;
          s.approvals.push({
            ...data,
            decidedAt: null,
            id: `ap-${s.nextId++}`,
            outcome: null,
            status: 'PENDING',
          });
        }
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const row: Row = {
        ...data,
        decidedAt: null,
        id: `ap-${s.nextId++}`,
        outcome: null,
        status: 'PENDING',
      };
      s.approvals.push(row);
      return { ...row };
    },
    findUnique: async ({
      where,
    }: {
      where: {
        id?: string;
        orchestrationId_callKey?: { orchestrationId: string; callKey: string };
      };
    }) => {
      if (s.failReads) {
        throw new Error('db down');
      }
      const found = s.approvals.find((a) =>
        where.id
          ? a.id === where.id
          : a.orchestrationId === where.orchestrationId_callKey?.orchestrationId &&
            a.callKey === where.orchestrationId_callKey?.callKey
      );
      return found ? { ...found } : null;
    },
    update: async ({ data, where }: { data: Partial<Row>; where: { id: string } }) => {
      const row = s.approvals.find((a) => a.id === where.id);
      if (!row) {
        throw new Error('missing');
      }
      Object.assign(row, data);
      return { ...row };
    },
    updateMany: async ({
      data,
      where,
    }: {
      data: Partial<Row>;
      where: { id: string; status: Row['status'] };
    }) => {
      const row = s.approvals.find((a) => a.id === where.id && a.status === where.status);
      if (row) {
        Object.assign(row, data);
      }
      return { count: row ? 1 : 0 };
    },
  };
  const message = {
    create: async (args: { data: Record<string, unknown> }) => {
      s.messages.push(args);
      return args;
    },
  };
  const tx = { orchestrationApproval: approval, orchestrationMessage: message };
  return {
    prisma: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        const snapshot = [...s.approvals];
        const msgs = [...s.messages];
        try {
          return await fn(tx);
        } catch (err) {
          // A failed transaction rolls back what it wrote, except the racing winner's row.
          const winner = s.approvals.find((a) => !snapshot.includes(a) && a.id.startsWith('ap-'));
          s.approvals = winner ? [...snapshot, winner] : snapshot;
          s.messages = msgs;
          throw err;
        }
      },
      connection: { findUnique: async () => ({ name: 'Billing MCP' }) },
      orchestration: {
        findUnique: async () => {
          if (s.failReads) {
            throw new Error('db down');
          }
          return s.orchestration;
        },
      },
      orchestrationApproval: approval,
      orchestrationChild: { findFirst: async () => ({ id: 'child-1' }) },
      orchestrationMessage: message,
      workflowRun: {
        findUnique: async () => {
          if (s.failReads) {
            throw new Error('db down');
          }
          return { orchestrationId: s.runOrchestrationId };
        },
      },
    },
  };
});

import {
  canonicalJson,
  createMcpApprovalGuard,
  type McpApprovalGuard,
  mcpCallKey,
  redactedArgumentsDigest,
} from './mcpApproval.js';

const CONNECTION = 'conn-1';
const NOW = Date.parse('2026-11-17T12:00:00Z');
const WRITE = { readOnlyHint: false };
const READ = { readOnlyHint: true };

const tracer = () => ({ addActivityEvent: vi.fn(), addToolCall: vi.fn() });

/** A guard whose sleep runs `onSleep(n)` first, so a test can play the launcher. */
async function guardWith(
  options: {
    onSleep?: (n: number) => void;
    now?: () => number;
    signal?: AbortSignal;
    connectionId?: string;
    t?: ReturnType<typeof tracer>;
  } = {}
): Promise<McpApprovalGuard> {
  let sleeps = 0;
  const guard = await createMcpApprovalGuard({
    connectionId: options.connectionId ?? CONNECTION,
    now: options.now ?? (() => NOW),
    pollIntervalMs: 2000,
    runId: 'run-1',
    signal: options.signal,
    sleep: async () => {
      sleeps += 1;
      options.onSleep?.(sleeps);
    },
    tracer: options.t,
  });
  if (!guard) {
    throw new Error('expected a guard');
  }
  return guard;
}

const decide = (status: Row['status']) => () => {
  for (const row of h.state.approvals) {
    if (row.status === 'PENDING') {
      row.status = status;
      row.decidedAt = new Date(NOW);
    }
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  const s = h.state;
  s.approvals = [];
  s.messages = [];
  s.nextId = 1;
  s.failReads = false;
  s.raceOnFirstCreate = false;
  s.runOrchestrationId = 'orch-1';
  s.orchestration = { connectionIds: [CONNECTION], launchedById: 'user-1', teamId: 'team-1' };
  h.timeout.mockResolvedValue(600);
});

describe('createMcpApprovalGuard', () => {
  it('returns null for a run that belongs to no orchestration', async () => {
    h.state.runOrchestrationId = null;
    expect(await createMcpApprovalGuard({ connectionId: CONNECTION, runId: 'run-1' })).toBeNull();
  });

  it('refuses everything when the run must be orchestrated but its row says otherwise', async () => {
    h.state.runOrchestrationId = null;
    const guard = await createMcpApprovalGuard({
      connectionId: CONNECTION,
      expectOrchestrated: true,
      runId: 'run-1',
    });
    const exec = vi.fn(async () => 'ran');
    expect(await guard?.run({ annotations: READ, args: {}, toolName: 't' }, exec)).toMatchObject({
      ran: false,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails closed when the database cannot be read', async () => {
    h.state.failReads = true;
    const guard = await createMcpApprovalGuard({ connectionId: CONNECTION, runId: 'run-1' });
    const exec = vi.fn(async () => 'ran');
    expect(await guard?.run({ annotations: READ, args: {}, toolName: 't' }, exec)).toMatchObject({
      ran: false,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails closed when the orchestration row is missing', async () => {
    h.state.orchestration = null;
    const guard = await createMcpApprovalGuard({ connectionId: CONNECTION, runId: 'run-1' });
    const exec = vi.fn(async () => 'ran');
    expect(await guard?.run({ annotations: READ, args: {}, toolName: 't' }, exec)).toMatchObject({
      ran: false,
    });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('guard: classification', () => {
  it('runs a read-only tool with no approval row, message or wait', async () => {
    const guard = await guardWith();
    const exec = vi.fn(async () => 'ok');
    const out = await guard.run({ annotations: READ, args: { q: 1 }, toolName: 'lookup' }, exec);
    expect(out).toEqual({ ran: true, value: 'ok' });
    expect(h.state.approvals).toHaveLength(0);
    expect(h.state.messages).toHaveLength(0);
  });

  it.each([
    ['missing annotations', undefined],
    ['readOnlyHint false', WRITE],
    ['truthy but not true', { readOnlyHint: 'true' }],
    ['inherited hint', Object.create({ readOnlyHint: true })],
  ])('treats %s as a write', async (_label, annotations) => {
    const guard = await guardWith({ onSleep: decide('DENIED') });
    const exec = vi.fn(async () => 'ok');
    const out = await guard.run({ annotations, args: {}, toolName: 'wipe' }, exec);
    expect(out.ran).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(h.state.approvals).toHaveLength(1);
  });

  it('refuses a call on a connection outside the orchestration set, reads included', async () => {
    const guard = await guardWith({ connectionId: 'other' });
    const exec = vi.fn(async () => 'ok');
    const out = await guard.run({ annotations: READ, args: {}, toolName: 'lookup' }, exec);
    expect(out.ran).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(h.state.approvals).toHaveLength(0);
  });
});

describe('guard: a write', () => {
  it('opens one PENDING row and one APPROVAL_REQUEST, waits, then runs once when approved', async () => {
    const t = tracer();
    const guard = await guardWith({ onSleep: (n) => n === 2 && decide('APPROVED')(), t });
    const exec = vi.fn(async () => 'done');
    const out = await guard.run(
      { annotations: WRITE, args: { path: '/tmp/x' }, toolName: 'wipe' },
      exec
    );
    expect(out).toEqual({ ran: true, value: 'done' });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(h.beat).toHaveBeenCalledTimes(2);
    const [row] = h.state.approvals;
    expect(row).toMatchObject({
      childId: 'child-1',
      connectionId: CONNECTION,
      orchestrationId: 'orch-1',
      runId: 'run-1',
      toolName: 'wipe',
    });
    expect(row?.expiresAt.getTime()).toBe(NOW + 600_000);
    expect(h.timeout).toHaveBeenCalledWith('orchestration.approvalTimeoutSeconds', {
      teamId: 'team-1',
    });
    expect(h.state.messages).toHaveLength(1);
    expect(h.state.messages[0]?.data).toMatchObject({
      childId: 'child-1',
      kind: 'APPROVAL_REQUEST',
      payload: {
        approvalId: row?.id,
        argumentsDigest: 'path: string(6)',
        connectionName: 'Billing MCP',
        toolName: 'wipe',
      },
    });
    expect(t.addActivityEvent).toHaveBeenCalledWith({
      name: 'mcp.write_approved',
      outputJson: { approvalId: row?.id, toolName: 'wipe' },
    });
  });

  it('returns a do-not-retry tool error when the launcher denies, and never runs the call', async () => {
    const guard = await guardWith({ onSleep: decide('DENIED') });
    const exec = vi.fn(async () => 'done');
    const out = await guard.run({ annotations: WRITE, args: {}, toolName: 'wipe' }, exec);
    expect(out).toMatchObject({ message: expect.stringContaining('denied'), ran: false });
    expect(out.ran === false && out.message).toContain('Do not retry the same call');
    expect(exec).not.toHaveBeenCalled();
  });

  it('expires the row with a compare-and-set when nobody answers, and treats it as denied', async () => {
    let clock = NOW;
    const guard = await guardWith({
      now: () => clock,
      onSleep: () => {
        clock += 601_000;
      },
    });
    const exec = vi.fn(async () => 'done');
    const out = await guard.run({ annotations: WRITE, args: {}, toolName: 'wipe' }, exec);
    expect(out).toMatchObject({ message: expect.stringContaining('did not answer'), ran: false });
    expect(h.state.approvals[0]?.status).toBe('EXPIRED');
    expect(exec).not.toHaveBeenCalled();
  });

  it('keeps a decision that landed before the expiry compare-and-set', async () => {
    let clock = NOW;
    const guard = await guardWith({
      now: () => clock,
      onSleep: () => {
        // The launcher approves in the same instant the deadline passes.
        clock += 601_000;
        const row = h.state.approvals[0];
        if (row) {
          row.status = 'APPROVED';
        }
      },
    });
    const exec = vi.fn(async () => 'done');
    const out = await guard.run({ annotations: WRITE, args: {}, toolName: 'wipe' }, exec);
    expect(out).toEqual({ ran: true, value: 'done' });
  });

  it('gives identical calls distinct keys, and the same call the same key on a retry', async () => {
    const guard = await guardWith({ onSleep: decide('DENIED') });
    const call = { annotations: WRITE, args: { a: 1, b: [2] }, toolName: 'wipe' };
    await guard.run(call, async () => 1);
    await guard.run({ ...call, args: { a: 1, b: [2] } }, async () => 1);
    expect(h.state.approvals).toHaveLength(2);
    const [first, second] = h.state.approvals;
    expect(first?.callKey).not.toBe(second?.callKey);
    expect(h.state.messages).toHaveLength(2);

    // A retried attempt is a new guard issuing the same calls in the same order.
    const retry = await guardWith({ onSleep: () => undefined });
    h.state.approvals.forEach((a) => {
      a.status = 'DENIED';
    });
    await retry.run(call, async () => 1);
    await retry.run(call, async () => 1);
    expect(h.state.approvals).toHaveLength(2);
    expect(h.state.messages).toHaveLength(2);
  });

  it('after an approval, a retried attempt reuses the decision: no second row or message, one run', async () => {
    const first = await guardWith({ onSleep: decide('APPROVED') });
    // The activity dies after the approval but before the call runs.
    const crash = vi.fn(async () => {
      throw new Error('worker died');
    });
    await expect(
      first.run({ annotations: WRITE, args: { x: 1 }, toolName: 'wipe' }, crash)
    ).rejects.toThrow('worker died');

    // The call itself failed, so the attempt that follows must not run it again.
    const retry = await guardWith();
    const exec = vi.fn(async () => 'second');
    const out = await retry.run({ annotations: WRITE, args: { x: 1 }, toolName: 'wipe' }, exec);
    expect(out.ran).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(h.state.approvals).toHaveLength(1);
    expect(h.state.messages).toHaveLength(1);
  });

  it("runs an approved call that never started on the retry, and returns a finished call's result without running it", async () => {
    const t = tracer();
    // Approved while the activity was down; nothing has run.
    const opener = await guardWith({ onSleep: decide('APPROVED') });
    const exec1 = vi.fn(async () => ({ content: 'first' }));
    await opener.run({ annotations: WRITE, args: { x: 1 }, toolName: 'wipe' }, exec1);
    expect(exec1).toHaveBeenCalledTimes(1);

    const retry = await guardWith({ t });
    const exec2 = vi.fn(async () => ({ content: 'second' }));
    const out = await retry.run({ annotations: WRITE, args: { x: 1 }, toolName: 'wipe' }, exec2);
    expect(out).toEqual({ ran: true, replayed: true, value: { content: 'first' } });
    expect(exec2).not.toHaveBeenCalled();
    expect(h.state.approvals).toHaveLength(1);
    expect(h.state.messages).toHaveLength(1);
  });

  it('runs an already APPROVED row with no recorded start exactly once', async () => {
    const guard = await guardWith({ onSleep: decide('APPROVED') });
    // Pre-seed the row as the previous attempt left it: approved, never started.
    await guard.run({ annotations: WRITE, args: { x: 1 }, toolName: 'wipe' }, async () => 'a');
    const row = h.state.approvals[0] as Row;
    row.outcome = null;
    const exec = vi.fn(async () => 'b');
    const out = await (await guardWith()).run(
      { annotations: WRITE, args: { x: 1 }, toolName: 'wipe' },
      exec
    );
    expect(out).toEqual({ ran: true, value: 'b' });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(h.state.approvals).toHaveLength(1);
  });

  it('does not ask again for a row already denied or expired', async () => {
    const guard = await guardWith({ onSleep: decide('DENIED') });
    const call = { annotations: WRITE, args: {}, toolName: 'wipe' };
    await guard.run(call, async () => 1);
    const retry = await guardWith({
      onSleep: () => {
        throw new Error('must not wait');
      },
    });
    const exec = vi.fn(async () => 1);
    expect((await retry.run(call, exec)).ran).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(h.state.messages).toHaveLength(1);
  });

  it('reads the winner when two attempts race to create the row, and writes one message', async () => {
    h.state.raceOnFirstCreate = true;
    const guard = await guardWith({ onSleep: decide('DENIED') });
    const out = await guard.run({ annotations: WRITE, args: {}, toolName: 'wipe' }, async () => 1);
    expect(out.ran).toBe(false);
    expect(h.state.approvals).toHaveLength(1);
    expect(h.state.messages).toHaveLength(0);
  });

  it('denies at once, with no row, message or wait, for a service-principal orchestration', async () => {
    h.state.orchestration = { connectionIds: [CONNECTION], launchedById: null, teamId: 'team-1' };
    const guard = await guardWith({
      onSleep: () => {
        throw new Error('must not wait');
      },
    });
    const exec = vi.fn(async () => 1);
    const out = await guard.run({ annotations: WRITE, args: {}, toolName: 'wipe' }, exec);
    expect(out).toMatchObject({ message: expect.stringContaining('no person'), ran: false });
    expect(exec).not.toHaveBeenCalled();
    expect(h.state.approvals).toHaveLength(0);
    expect(h.state.messages).toHaveLength(0);
    // A read still runs.
    expect((await guard.run({ annotations: READ, args: {}, toolName: 'r' }, exec)).ran).toBe(true);
  });

  it('denies when the database fails while opening or polling, never running the call', async () => {
    const guard = await guardWith();
    h.state.failReads = true;
    const exec = vi.fn(async () => 1);
    const out = await guard.run({ annotations: WRITE, args: {}, toolName: 'wipe' }, exec);
    expect(out.ran).toBe(false);
    expect(exec).not.toHaveBeenCalled();

    h.state.failReads = false;
    const polling = await guardWith({
      onSleep: () => {
        h.state.failReads = true;
      },
    });
    const out2 = await polling.run({ annotations: WRITE, args: { n: 2 }, toolName: 'wipe' }, exec);
    expect(out2.ran).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('stops waiting promptly when the run aborts, without running the call', async () => {
    const ctl = new AbortController();
    const guard = await guardWith({ onSleep: () => ctl.abort(), signal: ctl.signal });
    const exec = vi.fn(async () => 1);
    const out = await guard.run({ annotations: WRITE, args: {}, toolName: 'wipe' }, exec);
    expect(out).toMatchObject({ message: expect.stringContaining('stopped'), ran: false });
    expect(exec).not.toHaveBeenCalled();
    expect(h.beat).toHaveBeenCalledTimes(1);
  });

  it('tolerates a heartbeat outside an activity', async () => {
    h.beat.mockImplementationOnce(() => {
      throw new Error('Activity context not initialized');
    });
    const guard = await guardWith({ onSleep: decide('APPROVED') });
    expect(
      (await guard.run({ annotations: WRITE, args: {}, toolName: 'w' }, async () => 1)).ran
    ).toBe(true);
  });

  it('rethrows an error the approved tool throws', async () => {
    const guard = await guardWith({ onSleep: decide('APPROVED') });
    await expect(
      guard.run({ annotations: WRITE, args: {}, toolName: 'w' }, async () => {
        throw new Error('remote failure');
      })
    ).rejects.toThrow('remote failure');
  });
});

describe('redaction', () => {
  const SECRET = 'sk-live-ABCDEF1234567890SECRETVALUE';

  it('describes arguments by name, type and size and never by value', () => {
    expect(
      redactedArgumentsDigest({
        body: SECRET,
        list: [1, 2, 3],
        n: 4,
        nested: { a: SECRET },
        z: null,
      })
    ).toBe('body: string(35), list: array(3), n: number, nested: object(1 keys), z: null');
    expect(redactedArgumentsDigest(undefined)).toBe('(no arguments)');
    expect(redactedArgumentsDigest(SECRET)).toBe('string(35)');
    expect(
      redactedArgumentsDigest(
        Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 1]))
      )
    ).toContain('+10 more');
  });

  it('puts a secret-looking value in no row, message, trace event or log', async () => {
    const t = tracer();
    const guard = await guardWith({ onSleep: decide('APPROVED'), t });
    await guard.run(
      {
        annotations: WRITE,
        args: { apiKey: SECRET, headers: { authorization: `Bearer ${SECRET}` } },
        toolName: 'post',
      },
      async () => 'ok'
    );
    const denied = await guardWith({ onSleep: decide('DENIED'), t });
    h.state.approvals.length = 0;
    await denied.run(
      { annotations: WRITE, args: { token: SECRET }, toolName: 'post' },
      async () => 'ok'
    );
    const everything = JSON.stringify([
      h.state.approvals,
      h.state.messages,
      t.addActivityEvent.mock.calls,
      t.addToolCall.mock.calls,
      h.log.mock.calls,
    ]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('ABCDEF1234567890');
  });
});

describe('call keys', () => {
  it('canonicalises key order and differs by run, tool, arguments and ordinal', () => {
    expect(canonicalJson({ a: { c: 2, d: 1 }, b: 1 })).toBe(
      canonicalJson({ a: { c: 2, d: 1 }, b: 1 })
    );
    const base = mcpCallKey('r', 't', { a: 1 }, 0);
    expect(mcpCallKey('r', 't', { a: 1 }, 0)).toBe(base);
    expect(base.length).toBeLessThan(200);
    for (const other of [
      mcpCallKey('r2', 't', { a: 1 }, 0),
      mcpCallKey('r', 't2', { a: 1 }, 0),
      mcpCallKey('r', 't', { a: 2 }, 0),
      mcpCallKey('r', 't', { a: 1 }, 1),
    ]) {
      expect(other).not.toBe(base);
    }
  });
});
