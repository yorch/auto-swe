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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
} = { cancelledHumanSteps: [], createWorkflowRun: [], domainStates: [], finalize: [] };

/** Spec served by the fake createWorkflowRun; set per test before starting. */
let currentSpec: Record<string, unknown> = {};
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
    return { runId: 'run-test-1', spec: currentSpec };
  },
  finalizeWorkflowRun: async (runId: string, status: string) => {
    calls.finalize.push({ runId, status });
  },
  recordWorkflowStep: async () => {},
  resolveHumanStep: async () => {},
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
  env = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    activities: fakeActivities,
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: path.resolve(__dirname, './index.ts'),
  });
  workerRun = worker.run();
}, 240_000);

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
