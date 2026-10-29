/**
 * RepoDependencyScanOneWorkflow in Temporal's time-skipping test server, against a fake scan
 * activity. It guards what the gateway relies on when it starts the workflow by name at
 * onboarding: that name, the `{ repoId }` argument, and that the activity's result is the
 * workflow's result.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

const TASK_QUEUE = 'repo-dependency-scan-one-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scanned: string[] = [];
let failWith: string | null = null;

const fakeActivities = {
  async detectRepoDependencies(input: { repoId: string }) {
    scanned.push(input.repoId);
    if (failWith) {
      throw new Error(failWith);
    }
    return { edgesUpserted: 2, scanned: ['package.json'], suggestions: 1 };
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
  scanned.length = 0;
  failWith = null;
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

describe('RepoDependencyScanOneWorkflow', () => {
  it('scans the one repository it is given and returns what the scan found', async () => {
    const result = await env.client.workflow.execute('RepoDependencyScanOneWorkflow', {
      args: [{ repoId: 'repo-1' }],
      taskQueue: TASK_QUEUE,
      workflowId: 'repo-dependency-scan-repo-1',
    });
    expect(scanned).toEqual(['repo-1']);
    expect(result).toEqual({ edgesUpserted: 2, scanned: ['package.json'], suggestions: 1 });
  });

  it('fails when the scan keeps failing, rather than reporting success', async () => {
    failWith = 'repository not found';
    await expect(
      env.client.workflow.execute('RepoDependencyScanOneWorkflow', {
        args: [{ repoId: 'repo-2' }],
        taskQueue: TASK_QUEUE,
        workflowId: 'repo-dependency-scan-repo-2',
      })
    ).rejects.toThrow();
    expect(scanned.length).toBeGreaterThan(0);
  }, 60_000);
});
