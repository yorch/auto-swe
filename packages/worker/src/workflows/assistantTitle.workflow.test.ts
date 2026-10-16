/**
 * AssistantTitleWorkflow in Temporal's time-skipping test server, against a fake naming activity:
 * the gateway starts it by the shared constant's name, and it names the conversation once.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_TITLE_WORKFLOW,
  type AssistantTitleInput,
  assistantTitleWorkflowId,
} from '@auto-swe/shared/lib/assistantConversation';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import * as workflows from './index.js';

const TASK_QUEUE = 'assistant-title-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const named: AssistantTitleInput[] = [];
const fakeActivities = {
  async nameAssistantConversationNow(input: AssistantTitleInput) {
    named.push(input);
    return 'named' as const;
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

describe('AssistantTitleWorkflow', () => {
  it('is exported under the name the gateway starts it by', () => {
    expect(ASSISTANT_TITLE_WORKFLOW in workflows).toBe(true);
  });
});

describe('AssistantTitleWorkflow in the test server', () => {
  beforeEach((ctx: TestContext) => {
    if (!env || !worker) {
      ctx.skip();
    }
    named.length = 0;
  });

  it('names the conversation once', async () => {
    const input = { conversationId: 'conv-1', userId: 'user-1' };
    await env.client.workflow.execute(ASSISTANT_TITLE_WORKFLOW, {
      args: [input],
      taskQueue: TASK_QUEUE,
      workflowId: assistantTitleWorkflowId(input.conversationId),
    });
    expect(named).toEqual([input]);
  });
});
