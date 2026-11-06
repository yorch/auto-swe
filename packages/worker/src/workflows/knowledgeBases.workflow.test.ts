import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let env: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;
let ids: string[] = [];
const indexed: Array<{ id: string; sha?: string }> = [];
const queue = 'knowledge-base-workflow-test';

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  env = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    activities: {
      getKnowledgeBasesForSync: async () => ids,
      indexKnowledgeBaseSnapshot: async (id: string, sha?: string) => {
        indexed.push({ id, sha });
        if (id === 'bad') {
          throw ApplicationFailure.nonRetryable('Knowledge base indexing failed');
        }
        return { sha: sha ?? 'resolved-sha', snapshotId: 'snapshot' };
      },
    },
    connection: env.nativeConnection,
    taskQueue: queue,
    workflowsPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), './index.ts'),
  });
  running = worker.run();
}, 240_000);
beforeEach(() => {
  ids = [];
  indexed.length = 0;
});
afterAll(async () => {
  worker?.shutdown();
  await running;
  await env?.teardown();
}, 60_000);

describe('knowledge base workflows', () => {
  it('starts the indexing activity with the gateway contract and optional pinned SHA', async () => {
    await env.client.workflow.execute('IndexKnowledgeBaseWorkflow', {
      args: [{ knowledgeBaseId: 'kb', sha: 'pinned-sha' }],
      taskQueue: queue,
      workflowId: 'direct-kb',
    });
    expect(indexed).toEqual([{ id: 'kb', sha: 'pinned-sha' }]);
  });
  it('has no indexing work in an empty deployment', async () => {
    expect(
      await env.client.workflow.execute('ScheduledKnowledgeBaseSyncWorkflow', {
        args: [],
        taskQueue: queue,
        workflowId: 'empty-sync',
      })
    ).toEqual({ failed: 0, indexed: 0 });
    expect(indexed).toEqual([]);
  });
  it('sweeps every active base and continues after a failed source', async () => {
    ids = ['first', 'bad', 'last'];
    expect(
      await env.client.workflow.execute('ScheduledKnowledgeBaseSyncWorkflow', {
        args: [],
        taskQueue: queue,
        workflowId: 'full-sync',
      })
    ).toEqual({ failed: 1, indexed: 2 });
    expect(indexed.map((item) => item.id)).toEqual(ids);
    const handle = env.client.workflow.getHandle('knowledge-base-index-first');
    expect((await handle.describe()).type).toBe('IndexKnowledgeBaseWorkflow');
  });
});
