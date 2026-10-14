/**
 * ScheduledRevalidationWorkflow and EvalScreenWorkflow in Temporal's
 * time-skipping test server, against fake activities. They guard the sweep's
 * shape: every dataset is re-validated and then flake-screened, one dataset at a
 * time, and a failure in one dataset's screen is recorded without aborting the others.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlakeScreenResult } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

const TASK_QUEUE = 'scheduled-revalidation-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const calls: string[] = [];
let failingScreen = new Set<string>();
/** What the count activity answers, one per call; 0 once exhausted. */
let remaining: number[] = [];
/** Screens in flight at once, and the most there ever were. */
let activeScreens = 0;
let maxActiveScreens = 0;

const screened = (datasetId: string): FlakeScreenResult => ({
  erroredCaseIds: [],
  failedCaseIds: [`${datasetId}-flaky`],
  passed: 1,
  screened: 2,
});

const fakeActivities = {
  async countUnscreenedCasesActivity(datasetId: string) {
    calls.push(`count:${datasetId}`);
    return remaining.shift() ?? 0;
  },
  async getDatasetsForRevalidation() {
    return [{ datasetId: 'd1' }, { datasetId: 'd2' }];
  },
  async revalidateDatasetActivity(datasetId: string) {
    calls.push(`revalidate:${datasetId}`);
    return { checked: 2, quarantined: 0, restored: 0 };
  },
  async screenDatasetCasesActivity(datasetId: string): Promise<FlakeScreenResult> {
    calls.push(`screen:${datasetId}`);
    activeScreens += 1;
    maxActiveScreens = Math.max(maxActiveScreens, activeScreens);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (failingScreen.has(datasetId)) {
        throw ApplicationFailure.nonRetryable('docker unavailable');
      }
      return screened(datasetId);
    } finally {
      activeScreens -= 1;
    }
  },
};

let env: TestWorkflowEnvironment;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;

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
    taskQueue: TASK_QUEUE,
    workflowsPath: path.resolve(__dirname, './index.ts'),
  });
  workerRun = worker.run();
}, 240_000);

beforeEach((ctx: TestContext) => {
  if (!env || !worker) {
    ctx.skip();
  }
  calls.length = 0;
  failingScreen = new Set();
  remaining = [];
  maxActiveScreens = 0;
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

describe('ScheduledRevalidationWorkflow', () => {
  it('flake-screens each dataset after re-validating it', async () => {
    const result = await env.client.workflow.execute('ScheduledRevalidationWorkflow', {
      args: [{}],
      taskQueue: TASK_QUEUE,
      workflowId: 'revalidation-screens',
    });
    expect(result.screenResults).toEqual([
      { datasetId: 'd1', result: screened('d1') },
      { datasetId: 'd2', result: screened('d2') },
    ]);
    for (const id of ['d1', 'd2']) {
      expect(calls.indexOf(`revalidate:${id}`)).toBeLessThan(calls.indexOf(`screen:${id}`));
    }
  });

  it('screens one dataset at a time, after every re-validation', async () => {
    await env.client.workflow.execute('ScheduledRevalidationWorkflow', {
      args: [{}],
      taskQueue: TASK_QUEUE,
      workflowId: 'revalidation-screens-sequential',
    });
    expect(maxActiveScreens).toBe(1);
    expect(calls.slice(2)).toEqual(['screen:d1', 'screen:d2']);
  });

  it("records one dataset's screen failure without aborting the others", async () => {
    failingScreen = new Set(['d1']);
    const result = await env.client.workflow.execute('ScheduledRevalidationWorkflow', {
      args: [{}],
      taskQueue: TASK_QUEUE,
      workflowId: 'revalidation-screen-failure',
    });
    expect(result.caseResults).toHaveLength(2);
    expect(result.screenResults).toEqual([
      { datasetId: 'd1', result: { error: expect.any(String) } },
      { datasetId: 'd2', result: screened('d2') },
    ]);
  });
});

describe('EvalScreenWorkflow', () => {
  it("screens the dataset's never-screened cases", async () => {
    const result = await env.client.workflow.execute('EvalScreenWorkflow', {
      args: [{ datasetId: 'd1' }],
      taskQueue: TASK_QUEUE,
      workflowId: 'eval-screen-d1',
    });
    expect(result).toEqual(screened('d1'));
    expect(calls).toEqual(['screen:d1', 'count:d1']);
  });

  it('screens again while cases that arrived after the last load remain', async () => {
    remaining = [2, 1, 0];
    const result = await env.client.workflow.execute('EvalScreenWorkflow', {
      args: [{ datasetId: 'd1' }],
      taskQueue: TASK_QUEUE,
      workflowId: 'eval-screen-rounds',
    });
    expect(calls.filter((x) => x === 'screen:d1')).toHaveLength(3);
    expect(result.screened).toBe(6);
    expect(result.failedCaseIds).toEqual(['d1-flaky', 'd1-flaky', 'd1-flaky']);
  });

  it('stops after a bounded number of screens', async () => {
    remaining = Array.from({ length: 20 }, () => 1);
    await env.client.workflow.execute('EvalScreenWorkflow', {
      args: [{ datasetId: 'd1' }],
      taskQueue: TASK_QUEUE,
      workflowId: 'eval-screen-bounded',
    });
    expect(calls.filter((x) => x === 'screen:d1')).toHaveLength(5);
  });
});
