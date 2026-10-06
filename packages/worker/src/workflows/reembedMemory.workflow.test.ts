/**
 * ReembedStaleMemoryWorkflow in Temporal's time-skipping test server, against a
 * fake batch activity over an in-memory list of stale ids. It guards the walk's
 * shape: every batch advances the cursor, totals survive continue-as-new, and a
 * failing row is counted and passed rather than retried forever.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import type {
  ReembedStaleMemoryBatchInput,
  ReembedStaleMemoryBatchResult,
} from '../activities/reembedMemory.js';

const TASK_QUEUE = 'reembed-memory-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ids in sort order, as the real lister returns them; `failing` ids throw.
let stale: string[] = [];
let failing = new Set<string>();
const cursors: Array<string | null> = [];

const fakeActivities = {
  async reembedStaleMemoryBatch(
    input: ReembedStaleMemoryBatchInput
  ): Promise<ReembedStaleMemoryBatchResult> {
    cursors.push(input.afterId);
    const ids = stale
      .filter((id) => input.afterId === null || id > input.afterId)
      .slice(0, input.batchSize);
    const failed = ids.filter((id) => failing.has(id)).length;
    // A re-embedded row is no longer stale; a failed one stays.
    stale = stale.filter((id) => !ids.includes(id) || failing.has(id));
    return {
      done: ids.length < input.batchSize,
      failed,
      lastId: ids[ids.length - 1] ?? input.afterId,
      reembedded: ids.length - failed,
    };
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
  stale = [];
  failing = new Set();
  cursors.length = 0;
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${String(i).padStart(6, '0')}`);

function run(workflowId: string) {
  return env.client.workflow.execute('ReembedStaleMemoryWorkflow', {
    args: [{}],
    taskQueue: TASK_QUEUE,
    workflowId,
  });
}

describe('ReembedStaleMemoryWorkflow', () => {
  it('finishes at once when nothing is stale', async () => {
    await expect(run('reembed-none')).resolves.toEqual({ failed: 0, reembedded: 0 });
    expect(cursors).toEqual([null]);
  });

  it('walks every batch, advancing the cursor each time', async () => {
    stale = ids(250);
    await expect(run('reembed-batches')).resolves.toEqual({ failed: 0, reembedded: 250 });
    expect(cursors).toEqual([null, 'id-000099', 'id-000199']);
    expect(stale).toEqual([]);
  });

  it('counts a failing row and moves past it, so the walk ends', async () => {
    stale = ids(150);
    failing = new Set(['id-000007', 'id-000120']);
    await expect(run('reembed-failures')).resolves.toEqual({ failed: 2, reembedded: 148 });
    expect(stale).toEqual(['id-000007', 'id-000120']);
  });

  it('carries the cursor and totals across continue-as-new', async () => {
    // 50 batches per execution: 5,050 rows need a second execution.
    stale = ids(5_050);
    await expect(run('reembed-continue')).resolves.toEqual({ failed: 0, reembedded: 5_050 });
    expect(cursors).toHaveLength(51);
    expect(cursors[50]).toBe('id-004999');
  }, 60_000);
});
