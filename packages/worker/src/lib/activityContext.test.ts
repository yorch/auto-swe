import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { seq: number; toolName: string | null } & Record<string, unknown>;

const h = vi.hoisted(() => ({
  current: { ctx: {} as object },
  notePersistedUsage: vi.fn(),
  rows: [] as Row[],
  runId: { value: 'run-1' as string | null },
  runLookupFails: { value: false },
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
        h.rows.push(...data);
        return { count: data.length };
      },
    },
    workflowRun: {
      findUnique: async () => {
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
vi.mock('./runlessBudget.js', () => ({ notePersistedUsage: h.notePersistedUsage }));

import { persistActivityTrace } from './activityContext.js';
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
  h.notePersistedUsage.mockClear();
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
    expect(h.notePersistedUsage).toHaveBeenCalledWith('wf-author-1', 'temporal-run-1', 200, 50);
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
