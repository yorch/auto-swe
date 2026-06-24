/**
 * Claude Tag (Phase 4): workflow-level tests for ChannelAssistantWorkflow via
 * TestWorkflowEnvironment. These run the REAL workflow code (placeholder →
 * chat.update live-progress, fallback to a fresh post, graceful error path)
 * inside Temporal's time-skipping test server with every activity replaced by an
 * in-process fake. First run downloads the test-server binary; CI caches it under
 * ~/.temporalio. Network-restricted environments skip via the beforeEach guard.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import type { TestContext } from 'vitest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TASK_QUEUE = 'channel-assistant-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Fake activities ──────────────────────────────────────────────────────────

interface UpdateCall {
  slackChannelId: string;
  ts: string;
  text: string;
}
interface PostCall {
  slackChannelId: string;
  threadTs: string;
  text: string;
}

const calls: {
  placeholders: Array<{ slackChannelId: string; threadTs: string }>;
  updates: UpdateCall[];
  posts: PostCall[];
} = { placeholders: [], posts: [], updates: [] };

// Per-test knobs.
let placeholderTs: string | null = '999.000';
let placeholderThrows = false;
let turnThrows = false;
let turnReply = 'here is the answer';

const fakeActivities = {
  postChannelPlaceholder: async (args: { slackChannelId: string; threadTs: string }) => {
    calls.placeholders.push(args);
    if (placeholderThrows) {
      throw new Error('placeholder post failed');
    }
    return { ts: placeholderTs };
  },
  postChannelReply: async (args: PostCall) => {
    calls.posts.push(args);
  },
  runChannelAssistantTurn: async (_input: ChannelAssistantTurnInput) => {
    if (turnThrows) {
      throw new Error('turn failed');
    }
    return { reply: turnReply };
  },
  updateChannelReply: async (args: UpdateCall) => {
    calls.updates.push(args);
  },
};

// ── Harness ──────────────────────────────────────────────────────────────────

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;

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
  calls.placeholders = [];
  calls.updates = [];
  calls.posts = [];
  placeholderTs = '999.000';
  placeholderThrows = false;
  turnThrows = false;
  turnReply = 'here is the answer';
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

const INPUT: ChannelAssistantTurnInput = {
  channelId: 'chan-1',
  orgId: 'org-1',
  slackChannelId: 'C123',
  teamId: 'team-1',
  threadTs: '111.222',
  userSlackId: 'U999',
  userText: 'hello',
};

function startArgs(workflowId: string) {
  return {
    args: [INPUT],
    taskQueue: TASK_QUEUE,
    workflowExecutionTimeout: '2 minutes',
    workflowId,
  } as const;
}

describe('ChannelAssistantWorkflow (TestWorkflowEnvironment)', () => {
  it('posts a placeholder then edits it in place with the reply', async () => {
    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-live'));

    expect(calls.placeholders).toHaveLength(1);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toEqual({
      slackChannelId: 'C123',
      text: 'here is the answer',
      ts: '999.000',
    });
    // No fresh post when the placeholder is editable.
    expect(calls.posts).toHaveLength(0);
  }, 60_000);

  it('falls back to a fresh post when the placeholder returns no ts', async () => {
    placeholderTs = null;

    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-nots'));

    expect(calls.updates).toHaveLength(0);
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]).toEqual({
      slackChannelId: 'C123',
      text: 'here is the answer',
      threadTs: '111.222',
    });
  }, 60_000);

  it('falls back to a fresh post when the placeholder activity throws', async () => {
    placeholderThrows = true;

    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-throw'));

    expect(calls.updates).toHaveLength(0);
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]?.text).toBe('here is the answer');
  }, 60_000);

  it('edits the placeholder with friendly error text when the turn fails', async () => {
    turnThrows = true;

    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-err'));

    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]?.text).toContain('hit an error');
    expect(calls.posts).toHaveLength(0);
  }, 60_000);

  it('posts a fresh error message when the turn fails and there was no placeholder', async () => {
    placeholderTs = null;
    turnThrows = true;

    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-err-nots'));

    expect(calls.updates).toHaveLength(0);
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]?.text).toContain('hit an error');
  }, 60_000);
});
