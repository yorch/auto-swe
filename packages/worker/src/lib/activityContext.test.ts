import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { seq: number; toolName: string | null } & Record<string, unknown>;

const h = vi.hoisted(() => ({
  current: { ctx: {} as object },
  restore: vi.fn(),
  rows: [] as Row[],
  runFindFirst: vi.fn(),
  runId: { value: 'run-1' as string | null },
  runLookupFails: { value: false },
  runLookups: { value: 0 },
  takePersistingUsage: vi.fn(),
  writeFails: { value: false },
}));

vi.mock('@temporalio/activity', () => ({
  activityInfo: () => ({
    activityType: 'generateWorkflowSpec',
    attempt: 1,
    workflowExecution: { runId: 'temporal-run-1', workflowId: 'wf-author-1' },
  }),
  Context: { current: () => h.current.ctx },
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agentTrace: {
      createMany: async ({ data }: { data: Row[] }) => {
        if (h.writeFails.value) {
          throw new Error('write failed');
        }
        h.rows.push(...data);
        return { count: data.length };
      },
    },
    workflowRun: {
      findFirst: h.runFindFirst,
      findUnique: async () => {
        h.runLookups.value++;
        if (h.runLookupFails.value) {
          throw new Error('connection reset');
        }
        return h.runId.value ? { id: h.runId.value } : null;
      },
    },
  },
}));
vi.mock('./spendOwner.js', () => ({
  currentSpendOwner: async () => ({ orgId: 'org-1', teamId: 'team-1' }),
}));
vi.mock('./runlessBudget.js', () => ({ takePersistingUsage: h.takePersistingUsage }));

import {
  currentRunningWorkflowRunId,
  persistActivityTrace,
  startTraceFlushing,
} from './activityContext.js';
import { AgentTracer } from './agentTracer.js';

function tracerWith(...names: string[]): AgentTracer {
  const t = new AgentTracer();
  for (const name of names) {
    t.addActivityEvent({ name });
  }
  return t;
}

beforeEach(() => {
  h.rows.length = 0;
  h.current.ctx = {};
  h.runId.value = 'run-1';
  h.runLookupFails.value = false;
  h.runLookups.value = 0;
  h.writeFails.value = false;
  h.restore.mockReset();
  h.takePersistingUsage.mockReset();
  h.takePersistingUsage.mockReturnValue(h.restore);
});

describe('persistActivityTrace — seq', () => {
  it('numbers every tracer an attempt persists in one sequence', async () => {
    // e.g. validateContext's own tracer after runAgent's: each counts from 0.
    await persistActivityTrace(tracerWith('a', 'b'), 'k');
    await persistActivityTrace(tracerWith('c'), 'k');

    expect(h.rows.map((r) => [r.toolName, r.seq])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('starts again at 0 for the next attempt', async () => {
    await persistActivityTrace(tracerWith('a'), 'k');
    h.current.ctx = {};
    await persistActivityTrace(tracerWith('b'), 'k');

    expect(h.rows.map((r) => r.seq)).toEqual([0, 0]);
  });
});

describe('persistActivityTrace — repeated flushes of one tracer', () => {
  it('writes every record once, with unique ascending seq across flushes and tracers', async () => {
    const a = tracerWith('a1', 'a2');
    await persistActivityTrace(a, 'k');
    const b = tracerWith('b1');
    await persistActivityTrace(b, 'k');
    a.addActivityEvent({ name: 'a3' });
    a.addActivityEvent({ name: 'a4' });
    await persistActivityTrace(a, 'k');
    a.addActivityEvent({ name: 'a5' });
    await persistActivityTrace(a, 'k');
    await persistActivityTrace(a, 'k');

    expect(h.rows.map((r) => [r.toolName, r.seq])).toEqual([
      ['a1', 0],
      ['a2', 1],
      ['b1', 2],
      ['a3', 3],
      ['a4', 4],
      ['a5', 5],
    ]);
  });

  it('serializes flushes: a later one waits for the in-flight write', async () => {
    const order: string[] = [];
    const t = tracerWith('a');
    const persist = t.persist.bind(t);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    t.persist = async (...args) => {
      order.push('start');
      const ok = await persist(...args);
      if (first) {
        first = false;
        await gate;
      }
      order.push('end');
      return ok;
    };

    const early = persistActivityTrace(t, 'k');
    await new Promise((resolve) => setImmediate(resolve));
    t.addActivityEvent({ name: 'b' });
    const final = persistActivityTrace(t, 'k');
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['start']);
    release();
    await Promise.all([early, final]);

    expect(order).toEqual(['start', 'end', 'start', 'end']);
    expect(h.rows.map((r) => [r.toolName, r.seq])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('moves only the tokens written in each flush, and restores a failed one', async () => {
    const t = new AgentTracer();
    t.addLlmResponse({ durationMs: 1, inputTokens: 10, outputTokens: 1 });
    await persistActivityTrace(t, 'k');
    t.addLlmResponse({ durationMs: 1, inputTokens: 20, outputTokens: 2 });
    h.writeFails.value = true;
    await persistActivityTrace(t, 'k');
    h.writeFails.value = false;
    t.addLlmResponse({ durationMs: 1, inputTokens: 40, outputTokens: 4 });
    await persistActivityTrace(t, 'k');

    expect(h.takePersistingUsage.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      [10, 1],
      [20, 2],
      [60, 6],
    ]);
    expect(h.restore).toHaveBeenCalledTimes(1);
    expect(h.rows.map((r) => r.inputTokens)).toEqual([10, 20, 40]);
  });
});

describe('persistActivityTrace — empty tracer', () => {
  it('does no lookups and writes nothing', async () => {
    await expect(persistActivityTrace(new AgentTracer(), 'k')).resolves.toBe(true);
    expect(h.runLookups.value).toBe(0);
    expect(h.takePersistingUsage).not.toHaveBeenCalled();
  });
});

describe('startTraceFlushing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes records shortly after they are recorded, before any final persist', async () => {
    const t = new AgentTracer();
    const stop = startTraceFlushing(t, 'implementer', 1000);
    t.addActivityEvent({ name: 'a' });
    t.addActivityEvent({ name: 'b' });
    expect(h.rows).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rows.map((r) => r.toolName)).toEqual(['a', 'b']);

    t.addActivityEvent({ name: 'c' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rows.map((r) => r.toolName)).toEqual(['a', 'b', 'c']);

    t.addActivityEvent({ name: 'd' });
    stop();
    await persistActivityTrace(t, 'implementer');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.rows.map((r) => [r.toolName, r.seq])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ]);
  });

  it('does not queue a write per record while a flush is stalled', async () => {
    const t = new AgentTracer();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const persist = t.persist.bind(t);
    let calls = 0;
    t.persist = async (...args) => {
      calls++;
      const ok = await persist(...args);
      if (calls === 1) {
        await gate;
      }
      return ok;
    };
    const stop = startTraceFlushing(t, 'implementer', 1000);
    t.addActivityEvent({ name: 'a' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);

    for (let i = 0; i < 5; i++) {
      t.addActivityEvent({ name: `s${i}` });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(calls).toBe(1);
    // Nothing is armed behind the stalled write: no timer, so no queued write per record.
    expect(vi.getTimerCount()).toBe(0);

    release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
    expect(h.rows).toHaveLength(6);
    stop();
  });

  it('leaves records buffered after a failed flush for the final persist', async () => {
    const t = new AgentTracer();
    const stop = startTraceFlushing(t, 'implementer', 1000);
    h.writeFails.value = true;
    t.addActivityEvent({ name: 'a' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rows).toHaveLength(0);

    h.writeFails.value = false;
    stop();
    await persistActivityTrace(t, 'implementer');
    expect(h.rows.map((r) => r.toolName)).toEqual(['a']);
  });

  it('stop cancels a pending flush', async () => {
    const t = new AgentTracer();
    const stop = startTraceFlushing(t, 'implementer', 1000);
    t.addActivityEvent({ name: 'a' });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.rows).toHaveLength(0);
    expect(t.size).toBe(1);
  });
});

describe('persistActivityTrace — spend owner', () => {
  it('writes the execution and spend owner, then hands the persisted tokens to the runless sum', async () => {
    h.runId.value = null;
    const tracer = new AgentTracer();
    tracer.addLlmResponse({ durationMs: 1, inputTokens: 120, outputTokens: 30, role: 'r' });
    tracer.addLlmResponse({ durationMs: 1, inputTokens: 80, outputTokens: 20, role: 'r' });
    tracer.addActivityEvent({ name: 'e' });

    await persistActivityTrace(tracer, 'workflowAuthor');

    expect(h.rows[0]).toMatchObject({
      orgId: 'org-1',
      runId: null,
      teamId: 'team-1',
      temporalRunId: 'temporal-run-1',
      workflowId: 'wf-author-1',
    });
    expect(h.rows).toHaveLength(3);
    expect(h.takePersistingUsage).toHaveBeenCalledWith('wf-author-1', 'temporal-run-1', 200, 50);
    expect(h.restore).not.toHaveBeenCalled();
  });

  it('takes the tokens out of the runless sum before the write, and puts them back if it fails', async () => {
    h.writeFails.value = true;
    const order: string[] = [];
    h.takePersistingUsage.mockImplementation(() => {
      order.push('take');
      return h.restore;
    });
    const tracer = new AgentTracer();
    tracer.addLlmResponse({ durationMs: 1, inputTokens: 120, outputTokens: 30, role: 'r' });

    await persistActivityTrace(tracer, 'workflowAuthor');

    expect(order).toEqual(['take']);
    expect(h.rows).toHaveLength(0);
    expect(h.restore).toHaveBeenCalledOnce();
  });

  it('stamps no owner when the run lookup fails, so a run is never billed as runless too', async () => {
    h.runLookupFails.value = true;
    await persistActivityTrace(tracerWith('a'), 'implementer');

    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ orgId: null, runId: null, teamId: null });
  });

  it('stamps the owner beside the run id on a run-backed workflow', async () => {
    await persistActivityTrace(tracerWith('a'), 'implementer');
    expect(h.rows[0]).toMatchObject({ orgId: 'org-1', runId: 'run-1', teamId: 'team-1' });
  });
});

describe('currentRunningWorkflowRunId', () => {
  beforeEach(() => {
    h.runFindFirst.mockImplementation(async () => (h.runId.value ? { id: h.runId.value } : null));
  });

  it('resolves the run row only through the exact running execution identity', async () => {
    h.runId.value = 'db-run-uuid';
    await expect(currentRunningWorkflowRunId()).resolves.toBe('db-run-uuid');
    // The execution ids are part of the query rather than checked afterwards, so a row left
    // by an earlier execution of a reused workflow id can never be selected.
    expect(h.runFindFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { status: 'RUNNING', temporalRunId: 'temporal-run-1', workflowId: 'wf-author-1' },
    });
  });

  it('returns undefined when no matching running row exists', async () => {
    h.runId.value = null;
    await expect(currentRunningWorkflowRunId()).resolves.toBeUndefined();
  });
});
