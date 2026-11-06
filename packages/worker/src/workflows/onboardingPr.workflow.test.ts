/**
 * OnboardingPrWorkflow in Temporal's time-skipping test server, against a fake activity: it
 * returns the activity's result, retries a thrown error once and then succeeds, and hands the
 * activity exactly the input it was started with.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ONBOARDING_PR_WORKFLOW_TYPE,
  type OnboardingPrInput,
  type OnboardingPrResult,
  onboardingPrWorkflowId,
} from '@auto-swe/shared/lib/onboardingPrWorkflow';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import * as workflows from './index.js';
import { onboardingPrWorkflow } from './onboardingPr.js';

const TASK_QUEUE = 'onboarding-pr-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RESULT: OnboardingPrResult = {
  changed: ['.auto-swe/tools.yml'],
  pullRequestNumber: 7,
  pullRequestUrl: 'https://github.com/acme/api/pull/7',
  skipped: [],
  status: 'opened',
};

const received: OnboardingPrInput[] = [];
let failuresLeft = 0;
const fakeActivities = {
  async openOnboardingPr(input: OnboardingPrInput): Promise<OnboardingPrResult> {
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
      // The other workflow tests skip silently here; this one is also the check that
      // `workflows/index.ts` bundles in the V8 isolate, so a skip must be asked for.
      if (process.env.ALLOW_SKIP_TEMPORAL_TEST_SERVER === '1') {
        return;
      }
      throw new Error(
        `The ephemeral Temporal test server could not start (${String(e).split('\n')[0]}); ` +
          'set ALLOW_SKIP_TEMPORAL_TEST_SERVER=1 to skip this suite knowingly'
      );
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

describe('OnboardingPrWorkflow', () => {
  it('is exported under the name the gateway starts it by', () => {
    expect(onboardingPrWorkflow.name).toBe(ONBOARDING_PR_WORKFLOW_TYPE);
    expect(ONBOARDING_PR_WORKFLOW_TYPE in workflows).toBe(true);
  });
});

describe('OnboardingPrWorkflow in the test server', () => {
  beforeEach((ctx: TestContext) => {
    if (!env || !worker) {
      ctx.skip();
    }
    received.length = 0;
    failuresLeft = 0;
  });

  const input: OnboardingPrInput = {
    connectionId: 'conn-12345678-abcd',
    contentHash: 'abcd1234abcd1234',
    files: [{ kind: 'prPolicy' }],
    proposedById: 'user-1',
  };

  it('returns the activity result and passes it the exact input', async () => {
    const result = await env.client.workflow.execute(ONBOARDING_PR_WORKFLOW_TYPE, {
      args: [input],
      taskQueue: TASK_QUEUE,
      workflowId: onboardingPrWorkflowId(input.connectionId, 'run-one'),
    });
    expect(result).toEqual(RESULT);
    expect(received).toEqual([input]);
  });

  it('retries a thrown error once and then succeeds', async () => {
    failuresLeft = 1;
    const result = await env.client.workflow.execute(ONBOARDING_PR_WORKFLOW_TYPE, {
      args: [input],
      taskQueue: TASK_QUEUE,
      workflowId: onboardingPrWorkflowId(input.connectionId, 'run-two'),
    });
    expect(result).toEqual(RESULT);
    expect(received).toHaveLength(2);
  });
});
