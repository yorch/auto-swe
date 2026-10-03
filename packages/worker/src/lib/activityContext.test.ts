import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, current } = vi.hoisted(() => ({
  current: { ctx: {} as object },
  rows: [] as Array<{ seq: number; toolName: string | null }>,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agentTrace: {
      createMany: async ({ data }: { data: Array<{ seq: number; toolName: string | null }> }) => {
        rows.push(...data);
      },
    },
    workflowRun: { findUnique: async () => ({ id: 'run-1' }) },
  },
}));

vi.mock('@temporalio/activity', () => ({
  activityInfo: () => ({
    activityType: 'runAgentNode',
    attempt: 1,
    workflowExecution: { runId: 'r', workflowId: 'wf-1' },
  }),
  Context: { current: () => current.ctx },
}));

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
  rows.length = 0;
  current.ctx = {};
});

describe('persistActivityTrace', () => {
  it('numbers every tracer an attempt persists in one sequence', async () => {
    // e.g. validateContext's own tracer after runAgent's: each counts from 0.
    await persistActivityTrace(tracerWith('a', 'b'), 'k');
    await persistActivityTrace(tracerWith('c'), 'k');

    expect(rows.map((r) => [r.toolName, r.seq])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('starts again at 0 for the next attempt', async () => {
    await persistActivityTrace(tracerWith('a'), 'k');
    current.ctx = {};
    await persistActivityTrace(tracerWith('b'), 'k');

    expect(rows.map((r) => r.seq)).toEqual([0, 0]);
  });
});
