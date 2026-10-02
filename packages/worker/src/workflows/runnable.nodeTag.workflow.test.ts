/**
 * Trace attribution through the real path: the interpreter dispatches, the
 * workflow stamps a header on the scheduled activity, the worker's interceptor
 * exposes it, and `persistActivityTrace` writes it onto the `AgentTrace` row.
 * Only the activity bodies are fake; each one persists a trace the way a real
 * agent activity does, so what lands in `agent_traces` is what is asserted.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import { ApplicationFailure } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type TestContext,
  vi,
} from 'vitest';

const { rows } = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agentTrace: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        rows.push(...data);
        return { count: data.length };
      },
    },
    workflowRun: { findUnique: async () => ({ id: 'run-test-1' }) },
  },
}));

import { persistActivityTrace } from '../lib/activityContext.js';
import { activityNodeTagInterceptor } from '../lib/activityNodeTag.js';
import { AgentTracer } from '../lib/agentTracer.js';

const TASK_QUEUE = 'runnable-node-tag-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let currentSpec: Record<string, unknown> = {};

function makeSpec(nodes: Record<string, unknown>, entry: string) {
  return {
    description: '',
    entry,
    name: 'node-tag-spec',
    nodes,
    schemaVersion: SPEC_SCHEMA_VERSION,
  };
}

/** What a real agent activity does on its way out: persist its trace in a `finally`. */
async function traced(activity: string, body?: () => Promise<unknown>): Promise<unknown> {
  const tracer = new AgentTracer();
  try {
    return await body?.();
  } finally {
    tracer.addActivityEvent({ name: `${activity}.ran` });
    await persistActivityTrace(tracer, activity);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const counters: Record<string, number> = {};
const bump = (key: string) => {
  counters[key] = (counters[key] ?? 0) + 1;
  return counters[key] as number;
};

const fakeActivities = {
  cancelPendingHumanSteps: async () => {},
  createHumanStep: async () => {},
  createWorkflowRun: async () => ({ runId: 'run-test-1', spec: currentSpec }),
  executeImplementation: async (_request: unknown, subtask: { id: string; ms?: number }) =>
    traced('executeImplementation', async () => {
      // Reverse-ordered delays make later branches finish first, so a tag taken
      // from "the most recently dispatched node" would be wrong here.
      await sleep(subtask?.ms ?? 0);
      return { branch: `auto/${subtask?.id}`, headSha: 'sha' };
    }),
  finalizeWorkflowRun: async () => {},
  mcpCallTool: async () =>
    traced('mcpCallTool', async () => {
      // Fail the first Temporal attempt: the retry must keep the same node.
      if (bump('mcp') === 1) {
        throw new Error('transient');
      }
      return { ok: true };
    }),
  recordWorkflowStep: async () => {},
  resolveHumanStep: async () => {},
  runAgentNode: async () => traced('runAgentNode', async () => ({ ok: true })),
  runContainerStep: async () => traced('runContainerStep', async () => ({ ok: true })),
  runEvalNode: async () => traced('runEvalNode', async () => ({ score: 1 })),
  runLint: async () =>
    traced('runLint', async () => {
      // `flaky` fails its first interpreter attempt with a non-retryable error.
      if (bump('lint') === 1 && currentSpec.name === 'node-tag-retry') {
        throw ApplicationFailure.nonRetryable('lint failed', 'LINT');
      }
      return { passed: true };
    }),
  runShellStep: async () => traced('runShellStep', async () => ({ passed: true })),
  storeContextOverflowBatch: async () => [],
  updateDomainState: async () => {},
};

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  try {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  } catch (e) {
    if (/Failed to start ephemeral server|Forbidden|ECONNREFUSED/.test(String(e))) {
      return;
    }
    throw e;
  }
  worker = await Worker.create({
    activities: fakeActivities,
    connection: env.nativeConnection,
    interceptors: {
      activity: [activityNodeTagInterceptor],
      workflowModules: [path.resolve(__dirname, './nodeTagInterceptor.ts')],
    },
    taskQueue: TASK_QUEUE,
    workflowsPath: path.resolve(__dirname, './index.ts'),
  });
  workerRun = worker.run();
}, 240_000);

beforeEach((ctx: TestContext) => {
  if (!env || !worker) {
    ctx.skip();
  }
  rows.length = 0;
  for (const k of Object.keys(counters)) {
    delete counters[k];
  }
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

const REQUEST: RepoWorkRequest = {
  budgetTier: 'STANDARD',
  description: 'test',
  externalTicketId: 'T-1',
  repoId: '00000000-0000-4000-8000-000000000001',
  requestPayload: '{}',
  workRequestId: '00000000-0000-4000-8000-000000000002',
};

async function run(workflowId: string, spec: Record<string, unknown>) {
  currentSpec = spec;
  return (await env.client.workflow.execute('RunnableWorkflow', {
    args: [{ request: REQUEST, templateId: 'tpl-1', templateVersion: 1 }],
    taskQueue: TASK_QUEUE,
    workflowExecutionTimeout: '2 hours',
    workflowId,
  })) as { status: string };
}

const done = { status: 'SUCCESS', type: 'terminate' };
const byActivity = (name: string) => rows.filter((r) => r.nodeId === name);
const tagOf = (r: Record<string, unknown>) => ({
  attempt: r.attempt,
  recording: r.recordingId,
  spec: r.specNodeId,
  step: r.stepAttempt,
});

describe('trace attribution through RunnableWorkflow', () => {
  it('tags the trace of every dispatch kind with its spec node', async () => {
    const result = await run(
      'wf-tag-kinds',
      makeSpec(
        {
          agentN: { agentRef: 'implementer', next: 'mcpN', type: 'agent' },
          containerN: { image: 'alpine', next: 'shellN', type: 'containerStep' },
          end: done,
          evalN: {
            next: 'containerN',
            scorers: [{ expr: 'true', kind: 'assert' }],
            target: { literal: 1 },
            type: 'eval',
          },
          lintN: { next: 'agentN', step: 'runLint', type: 'step' },
          mcpN: { connectionRef: 'conn', next: 'evalN', tool: 't', type: 'mcp' },
          shellN: { command: 'true', image: 'alpine', next: 'end', type: 'shell' },
        },
        'lintN'
      )
    );
    expect(result.status).toBe('SUCCESS');
    const byNode = Object.fromEntries(
      [
        ['runLint', 'lintN'],
        ['runAgentNode', 'agentN'],
        ['mcpCallTool', 'mcpN'],
        ['runEvalNode', 'evalN'],
        ['runContainerStep', 'containerN'],
        ['runShellStep', 'shellN'],
      ].map(([activity, node]) => [activity, { first: byActivity(activity as string)[0], node }])
    );
    for (const [activity, { first, node }] of Object.entries(byNode)) {
      expect(first, activity).toBeDefined();
      expect(first?.specNodeId, activity).toBe(node);
      expect(first?.recordingId, activity).toBe(node);
      expect(first?.stepAttempt, activity).toBe(1);
    }
  }, 120_000);

  it('tells two nodes that use the same step apart', async () => {
    await run(
      'wf-tag-same-step',
      makeSpec(
        {
          end: done,
          first: { next: 'second', step: 'runLint', type: 'step' },
          second: { next: 'end', step: 'runLint', type: 'step' },
        },
        'first'
      )
    );
    expect(byActivity('runLint').map((r) => r.specNodeId)).toEqual(['first', 'second']);
  }, 120_000);

  it('attributes each concurrent fan-out branch to its own recording id', async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: String(i), ms: (6 - i) * 40 }));
    const result = await run(
      'wf-tag-fanout',
      makeSpec(
        {
          branchDone: done,
          done,
          fan: {
            concurrency: 6,
            itemKey: 'subtask',
            join: 'done',
            over: { literal: items },
            subgraph: 'impl',
            type: 'fanOut',
          },
          impl: { next: 'branchDone', step: 'executeImplementation', type: 'step' },
        },
        'fan'
      )
    );
    expect(result.status).toBe('SUCCESS');
    const impl = byActivity('executeImplementation');
    expect(impl).toHaveLength(6);
    // The branch index is the item id, so a crossed tag shows up as a mismatch.
    expect(impl.map((r) => r.recordingId).sort()).toEqual(
      items.map((i) => `fan[${i.id}]/impl`).sort()
    );
    for (const r of impl) {
      expect(r.specNodeId).toBe('impl');
    }
    // Finish order is the reverse of dispatch order; attribution must not follow it.
    expect(impl[0]?.recordingId).toBe('fan[5]/impl');
  }, 120_000);

  it('keeps nested fan-out branches apart', async () => {
    await run(
      'wf-tag-nested',
      makeSpec(
        {
          branchDone: done,
          done,
          impl: { next: 'branchDone', step: 'executeImplementation', type: 'step' },
          inner: {
            concurrency: 2,
            itemKey: 'subtask',
            join: 'branchDone',
            over: {
              literal: [
                { id: 'x', ms: 60 },
                { id: 'y', ms: 0 },
              ],
            },
            subgraph: 'impl',
            type: 'fanOut',
          },
          outer: {
            concurrency: 2,
            itemKey: 'subtask',
            join: 'done',
            over: { literal: [1, 2] },
            subgraph: 'inner',
            type: 'fanOut',
          },
        },
        'outer'
      )
    );
    expect(
      byActivity('executeImplementation')
        .map((r) => r.recordingId)
        .sort()
    ).toEqual([
      'outer[0]/inner[0]/impl',
      'outer[0]/inner[1]/impl',
      'outer[1]/inner[0]/impl',
      'outer[1]/inner[1]/impl',
    ]);
  }, 120_000);

  it('keeps the node across Temporal retries and counts interpreter retries', async () => {
    await run(
      'wf-tag-mcp-retry',
      makeSpec(
        {
          end: done,
          mcpN: { connectionRef: 'conn', next: 'end', tool: 't', type: 'mcp' },
        },
        'mcpN'
      )
    );
    // Temporal's retry of one dispatch: same node, same interpreter attempt.
    expect(byActivity('mcpCallTool').map(tagOf)).toEqual([
      { attempt: 1, recording: 'mcpN', spec: 'mcpN', step: 1 },
      { attempt: 2, recording: 'mcpN', spec: 'mcpN', step: 1 },
    ]);

    rows.length = 0;
    await run('wf-tag-retry', {
      ...makeSpec(
        {
          end: done,
          flaky: { next: 'end', onFail: { retry: 1 }, step: 'runLint', type: 'step' },
        },
        'flaky'
      ),
      name: 'node-tag-retry',
    });
    // The interpreter re-dispatches: a fresh Temporal attempt 1, interpreter attempt 2.
    expect(byActivity('runLint').map(tagOf)).toEqual([
      { attempt: 1, recording: 'flaky', spec: 'flaky', step: 1 },
      { attempt: 1, recording: 'flaky', spec: 'flaky', step: 2 },
    ]);
  }, 120_000);
});
