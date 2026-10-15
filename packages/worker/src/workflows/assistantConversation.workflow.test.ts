/**
 * AssistantConversationWorkflow under Temporal's time-skipping test server, with the turn
 * activities replaced by in-process fakes: turns run in the order they were signalled, a turn that
 * cannot run fails its reply, and the workflow completes when idle and starts again on the next
 * message. Network-restricted environments skip via the beforeEach guard.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_CONVERSATION_WORKFLOW,
  ASSISTANT_TURN_SIGNAL,
  type AssistantTurnRequest,
  assistantConversationWorkflowId,
} from '@auto-swe/shared/lib/assistantConversation';
import { ApplicationFailure } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import type { TestContext } from 'vitest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantTurnInput } from '../activities/assistantTurn.js';
import { AssistantConversationWorkflow, assistantTurnSignal } from './assistantConversation.js';

const TASK_QUEUE = 'assistant-conversation-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const turnsRun: string[] = [];
const failed: string[] = [];
let failingReply: string | null = null;

const fakeActivities = {
  failAssistantReply: async ({ replyId }: { replyId: string }) => {
    failed.push(replyId);
  },
  runAssistantTurn: async (input: AssistantTurnInput) => {
    turnsRun.push(input.replyId);
    if (input.replyId === failingReply) {
      throw ApplicationFailure.nonRetryable('model unavailable');
    }
    return { status: 'COMPLETE' as const };
  },
};

let env: TestWorkflowEnvironment | undefined;
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
  turnsRun.length = 0;
  failed.length = 0;
  failingReply = null;
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

const turn = (n: number): AssistantTurnRequest => ({ replyId: `reply-${n}`, token: `asst_t${n}` });

async function startWithTurn(conversationId: string, first: AssistantTurnRequest) {
  const client = (env as TestWorkflowEnvironment).client;
  return client.workflow.signalWithStart(ASSISTANT_CONVERSATION_WORKFLOW, {
    args: [{ conversationId, userId: 'user-1' }],
    signal: ASSISTANT_TURN_SIGNAL,
    signalArgs: [first],
    taskQueue: TASK_QUEUE,
    workflowExecutionTimeout: '2 hours',
    workflowId: assistantConversationWorkflowId(conversationId),
  });
}

describe('AssistantConversationWorkflow', () => {
  it('is started and signalled by the names the gateway uses', () => {
    expect(AssistantConversationWorkflow.name).toBe(ASSISTANT_CONVERSATION_WORKFLOW);
    expect(assistantTurnSignal.name).toBe(ASSISTANT_TURN_SIGNAL);
  });

  it('answers turns in the order they were sent, then completes when idle', async () => {
    const handle = await startWithTurn('conv-order', turn(1));
    await handle.signal(ASSISTANT_TURN_SIGNAL, turn(2));
    await handle.signal(ASSISTANT_TURN_SIGNAL, turn(3));
    await handle.result();
    expect(turnsRun).toEqual(['reply-1', 'reply-2', 'reply-3']);
    expect(failed).toEqual([]);
  });

  it('fails the reply of a turn that could not run, and keeps going', async () => {
    failingReply = 'reply-1';
    const handle = await startWithTurn('conv-fail', turn(1));
    await handle.signal(ASSISTANT_TURN_SIGNAL, turn(2));
    await handle.result();
    expect(turnsRun).toEqual(['reply-1', 'reply-2']);
    expect(failed).toEqual(['reply-1']);
  });

  it('starts again for a message sent after it went idle', async () => {
    const first = await startWithTurn('conv-again', turn(1));
    await first.result();
    const second = await startWithTurn('conv-again', turn(2));
    await second.result();
    expect(turnsRun).toEqual(['reply-1', 'reply-2']);
  });
});
