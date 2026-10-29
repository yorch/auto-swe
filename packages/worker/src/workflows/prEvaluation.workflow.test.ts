/**
 * PrEvaluationWorkflow in Temporal's time-skipping test server, against a fake evaluation activity:
 * it returns the activity's result, retries a thrown error once and then succeeds, and hands the
 * activity exactly the input it was started with.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PR_EVALUATION_WORKFLOW_TYPE,
  type PrEvaluationInput,
  prEvaluationWorkflowId,
} from '@auto-swe/shared/lib/prEvaluationWorkflow';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import type { EvaluatePullRequestResult } from '../activities/evaluatePullRequest.js';
import * as workflows from './index.js';
import { prEvaluationWorkflow } from './prEvaluation.js';

const TASK_QUEUE = 'pr-evaluation-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RESULT: EvaluatePullRequestResult = {
  autoMerge: 'not-eligible',
  outcome: 'evaluated',
  riskClass: 'LOW',
  statusState: 'success',
};

const received: PrEvaluationInput[] = [];
let failuresLeft = 0;
const fakeActivities = {
  async evaluatePullRequest(input: PrEvaluationInput): Promise<EvaluatePullRequestResult> {
    received.push(input);
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error('transient failure');
    }
    return RESULT;
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

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

describe('PrEvaluationWorkflow', () => {
  it('is exported under the name the gateway starts it by', () => {
    expect(prEvaluationWorkflow.name).toBe(PR_EVALUATION_WORKFLOW_TYPE);
    expect(PR_EVALUATION_WORKFLOW_TYPE in workflows).toBe(true);
  });
});

describe('PrEvaluationWorkflow in the test server', () => {
  beforeEach((ctx: TestContext) => {
    if (!env || !worker) {
      ctx.skip();
    }
    received.length = 0;
    failuresLeft = 0;
  });

  const input: PrEvaluationInput = {
    connectionId: 'conn-12345678-abcd',
    prNumber: 42,
    trigger: 'pull_request.synchronize',
  };

  it('returns the activity result and passes it the exact input', async () => {
    const result = await env.client.workflow.execute(PR_EVALUATION_WORKFLOW_TYPE, {
      args: [input],
      taskQueue: TASK_QUEUE,
      workflowId: prEvaluationWorkflowId(input.connectionId, input.prNumber, 'delivery-1'),
    });
    expect(result).toEqual(RESULT);
    expect(received).toEqual([input]);
  });

  it('retries a thrown error once and then succeeds', async () => {
    failuresLeft = 1;
    const result = await env.client.workflow.execute(PR_EVALUATION_WORKFLOW_TYPE, {
      args: [input],
      taskQueue: TASK_QUEUE,
      workflowId: prEvaluationWorkflowId(input.connectionId, input.prNumber, 'delivery-2'),
    });
    expect(result).toEqual(RESULT);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(input);
  });
});
