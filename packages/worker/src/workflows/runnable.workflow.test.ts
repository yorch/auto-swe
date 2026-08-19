/**
 * TEST-2: workflow-level tests for RunnableWorkflow via TestWorkflowEnvironment.
 *
 * These run the REAL workflow code (signal registration, dispatcher wiring,
 * finalize-on-failure) inside Temporal's time-skipping test server, with every
 * activity replaced by an in-process fake. First run downloads the test-server
 * binary; CI caches it under ~/.temporalio.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

const TASK_QUEUE = 'runnable-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Fake activities ──────────────────────────────────────────────────────────

interface FinalizeCall {
  runId: string;
  status: string;
}

const calls: {
  createWorkflowRun: unknown[];
  finalize: FinalizeCall[];
  domainStates: string[];
  cancelledHumanSteps: string[];
  contextOverflows: { path: string; bytes: number }[];
  /** How many batch activity calls the run made — one per run, not one per value. */
  contextOverflowBatches: number;
} = {
  cancelledHumanSteps: [],
  contextOverflowBatches: 0,
  contextOverflows: [],
  createWorkflowRun: [],
  domainStates: [],
  finalize: [],
};

/** Spec served by the fake createWorkflowRun; set per test before starting. */
let currentSpec: Record<string, unknown> = {};
/**
 * Pinned-settings snapshot served by the fake createWorkflowRun. Undefined is
 * the realistic default: every run row created before the column existed
 * carries NULL, and the workflow must tolerate that — a workflow-task failure
 * retries forever instead of surfacing, so an unguarded read here would strand
 * those runs silently.
 */
let currentPinnedSettings: Record<string, unknown> | undefined;
let updateDomainStateImpl: (workflowId: string, status: string) => Promise<void> = async (
  _wf,
  status
) => {
  calls.domainStates.push(status);
};

function makeSpec(nodes: Record<string, unknown>, entry: string) {
  return {
    description: '',
    entry,
    name: 'test-spec',
    nodes,
    schemaVersion: SPEC_SCHEMA_VERSION,
  };
}

const fakeActivities = {
  cancelPendingHumanSteps: async (runId: string) => {
    calls.cancelledHumanSteps.push(runId);
  },
  createHumanStep: async () => {},
  createWorkflowRun: async (input: unknown) => {
    calls.createWorkflowRun.push(input);
    return { pinnedSettings: currentPinnedSettings, runId: 'run-test-1', spec: currentSpec };
  },
  finalizeWorkflowRun: async (runId: string, status: string) => {
    calls.finalize.push({ runId, status });
  },
  recordWorkflowStep: async () => {},
  resolveHumanStep: async () => {},
  storeContextOverflowBatch: async (input: {
    values: Array<{ path: string; content: string }>;
  }) => {
    calls.contextOverflowBatches += 1;
    return input.values.map((v) => {
      calls.contextOverflows.push({ bytes: v.content.length, path: v.path });
      return { artifactId: `art-${calls.contextOverflows.length}`, sizeBytes: v.content.length };
    });
  },
  updateDomainState: (workflowId: string, status: string) =>
    updateDomainStateImpl(workflowId, status),
};

// ── Harness ──────────────────────────────────────────────────────────────────

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;

beforeAll(async () => {
  // Quiet the worker logs in test output.
  Runtime.install({ logger: new DefaultLogger('WARN') });
  try {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  } catch (e) {
    // Network-restricted environments can't download the test-server binary.
    // Tests will be skipped individually via the beforeEach guard below.
    if (/Failed to start ephemeral server|Forbidden|ECONNREFUSED/.test(String(e))) {
      return;
    }
    throw e;
  }
  worker = await Worker.create({
    activities: fakeActivities,
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: path.resolve(__dirname, './index.ts'),
  });
  workerRun = worker.run();
}, 240_000);

beforeEach((ctx: TestContext) => {
  if (!env || !worker) {
    ctx.skip();
  }
  // Default to the pre-existing-run shape so a test that cares about pinning
  // has to opt in, and one that doesn't cannot accidentally depend on it.
  currentPinnedSettings = undefined;
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

const REQUEST = {
  budgetTier: 'STANDARD',
  description: 'test',
  externalTicketId: 'T-1',
  repoId: '00000000-0000-4000-8000-000000000001',
  requestPayload: '{}',
  workRequestId: '00000000-0000-4000-8000-000000000002',
};

function startArgs(workflowId: string) {
  return {
    args: [{ request: REQUEST, templateId: 'tpl-1', templateVersion: 1 }],
    taskQueue: TASK_QUEUE,
    workflowExecutionTimeout: '2 hours',
    workflowId,
  } as const;
}

describe('RunnableWorkflow (TestWorkflowEnvironment)', () => {
  it('runs a spec to SUCCESS and finalizes the run row', async () => {
    currentSpec = makeSpec(
      {
        done: { result: {}, status: 'SUCCESS', type: 'terminate' },
        setStatus: {
          config: { status: 'IMPLEMENTING' },
          next: 'done',
          step: 'updateDomainState',
          type: 'step',
        },
      },
      'setStatus'
    );
    const result = await env.client.workflow.execute('RunnableWorkflow', startArgs('wf-ok'));
    expect((result as { status: string }).status).toBe('SUCCESS');
    expect(calls.domainStates).toContain('IMPLEMENTING');
    expect(calls.finalize.at(-1)).toEqual({ runId: 'run-test-1', status: 'SUCCESS' });
  }, 120_000);

  it('runs a spec with no pinned-settings snapshot at all', async () => {
    // The pre-existing-run case: `pinned_settings` is NULL. The workflow must
    // fall back to the interpreter defaults rather than throwing.
    currentPinnedSettings = undefined;
    currentSpec = makeSpec({ done: { result: {}, status: 'SUCCESS', type: 'terminate' } }, 'done');
    const result = await env.client.workflow.execute('RunnableWorkflow', startArgs('wf-nopins'));
    expect((result as { status: string }).status).toBe('SUCCESS');
  }, 120_000);

  it('delivers a registered signal and routes onReceive', async () => {
    // waitSignal clears stale payloads when the interpreter REACHES the
    // wait node — a signal sent before that is intentionally dropped. Park
    // the workflow at the wait first (marker step + drain), then signal.
    currentSpec = makeSpec(
      {
        failed: { status: 'TIMED_OUT', type: 'terminate' },
        marker: {
          config: { status: 'AWAITING_SIGNAL' },
          next: 'wait',
          step: 'updateDomainState',
          type: 'step',
        },
        merged: { status: 'SUCCESS', type: 'terminate' },
        wait: {
          name: 'humanMergeSignal',
          onReceive: 'merged',
          onTimeout: 'failed',
          timeout: '1h',
          type: 'signal',
        },
      },
      'marker'
    );
    const handle = await env.client.workflow.start('RunnableWorkflow', startArgs('wf-signal'));
    // Wait (real time) until the marker step ran, then give the worker a
    // beat to park the workflow on the signal condition.
    const deadline = Date.now() + 15_000;
    while (!calls.domainStates.includes('AWAITING_SIGNAL') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(calls.domainStates).toContain('AWAITING_SIGNAL');
    await env.sleep('1 second');
    await handle.signal('humanMergeSignal', true);
    const result = (await handle.result()) as { status: string };
    expect(result.status).toBe('SUCCESS');
  }, 120_000);

  it('routes onTimeout when the signal never arrives (time-skipping)', async () => {
    currentSpec = makeSpec(
      {
        failed: { status: 'TIMED_OUT', type: 'terminate' },
        merged: { status: 'SUCCESS', type: 'terminate' },
        wait: {
          name: 'humanMergeSignal',
          onReceive: 'merged',
          onTimeout: 'failed',
          timeout: '30m',
          type: 'signal',
        },
      },
      'wait'
    );
    const result = (await env.client.workflow.execute(
      'RunnableWorkflow',
      startArgs('wf-timeout')
    )) as { status: string };
    expect(result.status).toBe('TIMED_OUT');
    expect(calls.finalize.at(-1)).toEqual({ runId: 'run-test-1', status: 'TIMED_OUT' });
  }, 120_000);

  it('finalizes the run as FAILED when a blocking step exhausts retries', async () => {
    const before = calls.finalize.length;
    updateDomainStateImpl = async () => {
      throw new Error('state write exploded');
    };
    try {
      currentSpec = makeSpec(
        {
          done: { status: 'SUCCESS', type: 'terminate' },
          explode: {
            config: { status: 'IMPLEMENTING' },
            next: 'done',
            step: 'updateDomainState',
            type: 'step',
          },
        },
        'explode'
      );
      await expect(
        env.client.workflow.execute('RunnableWorkflow', startArgs('wf-fail'))
      ).rejects.toThrow();
      // finalize-on-failure: the FAILED status must land even though runSpec threw.
      expect(calls.finalize.length).toBeGreaterThan(before);
      expect(calls.finalize.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
      expect(calls.cancelledHumanSteps).toContain('run-test-1');
    } finally {
      updateDomainStateImpl = async (_wf, status) => {
        calls.domainStates.push(status);
      };
    }
  }, 120_000);
});

describe('RunnableWorkflow — oversized context values', () => {
  it('spills a large string to an artifact instead of truncating it', async () => {
    calls.contextOverflows.length = 0;
    const big = 'x'.repeat(9000);
    currentSpec = makeSpec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        seed: { next: 'done', type: 'set', values: { 'context.bigDiff': { literal: big } } },
      },
      'seed'
    );

    const result = (await env.client.workflow.execute(
      'RunnableWorkflow',
      startArgs('wf-overflow')
    )) as { status: string };
    expect(result.status).toBe('SUCCESS');

    // The whole value reaches the artifact — the point of the change is that
    // nothing is silently discarded.
    const spill = calls.contextOverflows.find((o) => o.path.includes('bigDiff'));
    expect(spill).toBeDefined();
    expect(spill?.bytes).toBe(9000);
  }, 120_000);

  it('spills every oversized value, past what the old 20-spill cap allowed', async () => {
    calls.contextOverflows.length = 0;
    calls.contextOverflowBatches = 0;
    const COUNT = 25;
    const big = 'y'.repeat(5000);
    const values: Record<string, unknown> = {};
    for (let i = 0; i < COUNT; i++) {
      values[`context.big${i}`] = { literal: `${big}${i}` };
    }
    currentSpec = makeSpec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        seed: { next: 'done', type: 'set', values },
      },
      'seed'
    );

    const result = (await env.client.workflow.execute(
      'RunnableWorkflow',
      startArgs('wf-overflow-many')
    )) as { status: string };
    expect(result.status).toBe('SUCCESS');

    // The cap used to truncate everything past the 20th value.
    expect(calls.contextOverflows).toHaveLength(COUNT);
    // ...and it existed because each spill was its own activity call. One call
    // for the whole set is what makes removing the cap affordable.
    expect(calls.contextOverflowBatches).toBe(1);
  }, 120_000);

  it('splits the spill across activities when the payload would be too large', async () => {
    calls.contextOverflows.length = 0;
    calls.contextOverflowBatches = 0;
    // Three values of 600KB: one batch would be ~1.8MB, past what a single
    // Temporal activity input should carry. Sending them all in one call would
    // fail the run at its final step — strictly worse than the truncation the
    // batching replaced.
    const big = 'z'.repeat(600_000);
    currentSpec = makeSpec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        seed: {
          next: 'done',
          type: 'set',
          values: {
            'context.a': { literal: `${big}a` },
            'context.b': { literal: `${big}b` },
            'context.c': { literal: `${big}c` },
          },
        },
      },
      'seed'
    );

    const result = (await env.client.workflow.execute(
      'RunnableWorkflow',
      startArgs('wf-overflow-chunked')
    )) as { status: string };
    expect(result.status).toBe('SUCCESS');

    // Nothing lost...
    expect(calls.contextOverflows).toHaveLength(3);
    // ...and no single call carried all of them.
    expect(calls.contextOverflowBatches).toBeGreaterThan(1);
  }, 120_000);

  it('leaves small values inline', async () => {
    calls.contextOverflows.length = 0;
    currentSpec = makeSpec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        seed: { next: 'done', type: 'set', values: { 'context.small': { literal: 'hello' } } },
      },
      'seed'
    );
    await env.client.workflow.execute('RunnableWorkflow', startArgs('wf-no-overflow'));
    expect(calls.contextOverflows).toHaveLength(0);
  }, 120_000);
});
