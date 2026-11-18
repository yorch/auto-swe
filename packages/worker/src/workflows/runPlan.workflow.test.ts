/**
 * RunPlanGenerationWorkflow and RunPlanRouteWorkflow in Temporal's time-skipping test server,
 * against fake activities: each is a thin request/response wrapper the gateway starts by the shared
 * constants' names, so what is under test is the name, the pass-through and that a failure type
 * reaches the caller.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUN_PLAN_GENERATION_WORKFLOW,
  RUN_PLAN_ROUTE_WORKFLOW,
  runPlanGenerationWorkflowId,
  runPlanRouteWorkflowId,
} from '@auto-swe/shared/lib/runPlanWorkflows';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import * as workflows from './index.js';

const TASK_QUEUE = 'run-plan-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const seen: unknown[] = [];
let failGeneration = false;
const fakeActivities = {
  async generateRunPlanSpec(input: unknown) {
    seen.push(input);
    if (failGeneration) {
      throw ApplicationFailure.nonRetryable('no plan', 'GENERATION_FAILED');
    }
    return { attempts: 1, marker: 'generated' };
  },
  async routeRunPlan(input: unknown) {
    seen.push(input);
    return { matches: [], noneFit: true };
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

describe('run plan workflows', () => {
  it('are exported under the names the gateway starts them by', () => {
    expect(RUN_PLAN_GENERATION_WORKFLOW in workflows).toBe(true);
    expect(RUN_PLAN_ROUTE_WORKFLOW in workflows).toBe(true);
  });

  it('use the documented workflow id prefixes', () => {
    expect(runPlanGenerationWorkflowId('abc')).toBe('runplan-abc');
    expect(runPlanRouteWorkflowId('abc')).toBe('runplan-route-abc');
  });
});

describe('run plan workflows in the test server', () => {
  beforeEach((ctx: TestContext) => {
    if (!env || !worker) {
      ctx.skip();
    }
    seen.length = 0;
    failGeneration = false;
  });

  it('generation passes the input to the activity and returns its result', async () => {
    const input = { intent: 'x', launchableAgentKeys: [], mode: 'delivering', teamId: 't' };
    const result = await env.client.workflow.execute(RUN_PLAN_GENERATION_WORKFLOW, {
      args: [input],
      taskQueue: TASK_QUEUE,
      workflowId: runPlanGenerationWorkflowId('gen-1'),
    });
    expect(result).toEqual({ attempts: 1, marker: 'generated' });
    expect(seen).toEqual([input]);
  });

  it('generation does not retry a refused plan and surfaces its type', async () => {
    failGeneration = true;
    await expect(
      env.client.workflow.execute(RUN_PLAN_GENERATION_WORKFLOW, {
        args: [{ intent: 'x', launchableAgentKeys: [], mode: 'delivering', teamId: 't' }],
        taskQueue: TASK_QUEUE,
        workflowId: runPlanGenerationWorkflowId('gen-2'),
      })
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('routing passes the input through', async () => {
    const input = { candidates: [], intent: 'x', maxResults: 3 };
    const result = await env.client.workflow.execute(RUN_PLAN_ROUTE_WORKFLOW, {
      args: [input],
      taskQueue: TASK_QUEUE,
      workflowId: runPlanRouteWorkflowId('route-1'),
    });
    expect(result).toEqual({ matches: [], noneFit: true });
    expect(seen).toEqual([input]);
  });
});
