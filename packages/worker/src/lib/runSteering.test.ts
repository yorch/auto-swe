import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const db = vi.hoisted(() => ({
  fail: false,
  queries: 0,
  rows: [] as Array<{
    authorId: string | null;
    body: string;
    deliveredAt: Date | null;
    id: string;
    runId: string;
  }>,
  updateFails: false,
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    runSteeringMessage: {
      findMany: vi.fn(async ({ where }: { where: { runId: string } }) => {
        db.queries += 1;
        if (db.fail) {
          throw new Error('db down');
        }
        return db.rows.filter((r) => r.runId === where.runId && r.deliveredAt === null);
      }),
      updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        if (db.updateFails) {
          throw new Error('db down');
        }
        for (const r of db.rows) {
          if (where.id.in.includes(r.id)) {
            r.deliveredAt = new Date();
          }
        }
        return { count: where.id.in.length };
      }),
    },
  },
}));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: vi.fn().mockReturnValue('wf-1'),
  persistActivityTrace: vi.fn().mockResolvedValue(undefined),
  startTraceFlushing: vi.fn(() => () => {}),
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn(async () => 50) }));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({})),
}));
vi.mock('../lib/cancellation.js', () => ({
  abortSignalOption: () => ({}),
  activityCancellationSignal: () => new AbortController().signal,
}));
vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  getModelPrice: vi.fn(async () => ({ known: true, price: {}, source: 'catalog' })),
  recordLlmUsage: vi.fn(async () => ({
    costUsd: 0.01,
    inputTokens: 10,
    modelSpec: 'x/y',
    outputTokens: 5,
  })),
}));

import { runAgent } from '../activities/runAgent.js';
import { AgentTracer } from './agentTracer.js';
import type { AgentSpec } from './config/agentSpec.js';
import {
  createSteeringPrepareStep,
  markSteeringDelivered,
  readRunSteering,
  STEERING_HEADING,
} from './runSteering.js';

const row = (id: string, body: string, runId = 'run-1', authorId: string | null = 'user-1') => ({
  authorId,
  body,
  deliveredAt: null as Date | null,
  id,
  runId,
});

beforeEach(() => {
  db.fail = false;
  db.queries = 0;
  db.rows = [];
  db.updateFails = false;
});

describe('readRunSteering', () => {
  it('returns null and reads once when nothing is waiting', async () => {
    expect(await readRunSteering('run-1')).toBeNull();
    expect(db.queries).toBe(1);
  });

  it('labels each message by who wrote it, and marks nothing itself', async () => {
    db.rows = [
      row('a', 'use pnpm'),
      row('b', 'skip tests', 'run-1', null),
      row('c', 'other run', 'run-2'),
    ];
    const out = await readRunSteering('run-1');
    expect(out?.block).toBe(
      `${STEERING_HEADING}\n- (from the launcher) use pnpm\n- (from the orchestrator, not the launcher) skip tests`
    );
    expect(out?.ids).toEqual(['a', 'b']);
    expect(db.rows.every((r) => r.deliveredAt === null)).toBe(true);
  });

  it('marks exactly the ids it is given', async () => {
    db.rows = [row('a', 'one'), row('b', 'two')];
    await markSteeringDelivered(['a']);
    expect(db.rows.map((r) => r.deliveredAt !== null)).toEqual([true, false]);
  });
});

describe('createSteeringPrepareStep', () => {
  it('adds the block to the history and records agent.steered', async () => {
    db.rows = [row('a', 'use pnpm')];
    const tracer = new AgentTracer();
    const add = vi.fn();
    const messageList = { add } as never;
    const result = await createSteeringPrepareStep('run-1', tracer)({ messageList });
    expect(add).toHaveBeenCalledWith(
      { content: expect.stringContaining('(from the launcher) use pnpm'), role: 'user' },
      'input'
    );
    expect(result).toEqual({ messageList });
    expect(JSON.stringify(tracer)).toContain('agent.steered');
  });

  it('leaves the messages undelivered when there is no history to append them to', async () => {
    db.rows = [row('a', 'use pnpm')];
    const out = await createSteeringPrepareStep('run-1', new AgentTracer())({});
    expect(out).toBeUndefined();
    expect(db.rows[0]?.deliveredAt).toBeNull();
    // Nothing was even read: the rows were never at risk.
    expect(db.queries).toBe(0);
  });

  it('injects before it marks: a failed mark still delivers, and is retried next step', async () => {
    db.rows = [row('a', 'use pnpm')];
    db.updateFails = true;
    const add = vi.fn();
    const out = await createSteeringPrepareStep(
      'run-1',
      new AgentTracer()
    )({ messageList: { add } as never });
    expect(add).toHaveBeenCalledTimes(1);
    expect(out).toBeDefined();
    expect(db.rows[0]?.deliveredAt).toBeNull();
  });

  it('lets the step proceed unsteered when the read fails, leaving the messages queued', async () => {
    db.rows = [row('a', 'use pnpm')];
    db.fail = true;
    const add = vi.fn();
    const out = await createSteeringPrepareStep(
      'run-1',
      new AgentTracer()
    )({
      messageList: { add } as never,
    });
    expect(out).toBeUndefined();
    expect(add).not.toHaveBeenCalled();
    expect(db.rows[0]?.deliveredAt).toBeNull();
  });
});

describe('Mastra loop integration', () => {
  const ping = createTool({
    description: 'ping',
    execute: async () => ({ ok: true }),
    id: 'ping',
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
  });

  it('hands a message queued mid-run to the NEXT model call, as a labelled user block', async () => {
    const prompts: string[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (opts: { prompt: unknown }) => {
        calls += 1;
        prompts.push(JSON.stringify(opts.prompt));
        // The person steers while the first model call is in flight.
        if (calls === 1) {
          db.rows.push(row('late', 'actually use pnpm'));
        }
        const done = calls === 2;
        return {
          content: done
            ? [{ text: 'all done', type: 'text' }]
            : [{ input: '{}', toolCallId: `c${calls}`, toolName: 'ping', type: 'tool-call' }],
          finishReason: done
            ? { raw: 'stop', unified: 'stop' }
            : { raw: 'tool-calls', unified: 'tool-calls' },
          usage: {
            inputTokens: { noCache: 10, total: 10 },
            outputTokens: { text: 5, total: 5 },
          },
          warnings: [],
        };
      },
    } as never);
    const spec: AgentSpec = {
      agent: null,
      agentKey: 'contentWriter',
      model: model as unknown as AgentSpec['model'],
      modelSpec: 'x/y',
      skills: [],
      systemPrompt: 'sys',
      tools: { ping } as unknown as AgentSpec['tools'],
    };
    const tracer = new AgentTracer();
    await runAgent(spec, 'do the task', {
      perStepAccounting: true,
      prepareStep: createSteeringPrepareStep('run-1', tracer),
      tracer,
    });
    expect(calls).toBe(2);
    expect(prompts[0]).not.toContain('actually use pnpm');
    expect(prompts[1]).toContain('actually use pnpm');
    expect(prompts[1]).toContain('Steering messages');
    expect(prompts[1]).toContain('from the launcher');
    expect(db.rows[0]?.deliveredAt).not.toBeNull();
    // One read per step boundary, and the message was handed over once.
    expect(db.queries).toBe(2);
  });
});
