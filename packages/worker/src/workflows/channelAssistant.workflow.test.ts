/**
 * Channel assistant (Phase 4): workflow-level tests for ChannelAssistantWorkflow via
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

interface StartRunCall {
  workflowId: string;
  channelId: string;
  kind: string;
}
interface FinalizeRunCall {
  workflowId: string;
  status: string;
}

const calls: {
  placeholders: Array<{ slackChannelId: string; threadTs: string }>;
  updates: UpdateCall[];
  posts: PostCall[];
  startRuns: StartRunCall[];
  finalizeRuns: FinalizeRunCall[];
  taskRuns: unknown[];
  codeTaskRuns: unknown[];
  budgetChecks: string[];
} = {
  budgetChecks: [],
  codeTaskRuns: [],
  finalizeRuns: [],
  placeholders: [],
  posts: [],
  startRuns: [],
  taskRuns: [],
  updates: [],
};

// Per-test knobs.
let placeholderTs: string | null = '999.000';
let placeholderThrows = false;
let turnThrows = false;
let turnReply = 'here is the answer';
// Phase A: optional delegate intent returned by the turn, + the budget verdict.
let turnDelegate:
  | { route: 'general' | 'code'; title: string; description: string; repoHint?: string }
  | undefined;
let overBudget = false;
// Phase B: per-test knob — when null, createChannelCodeTaskRun returns null (no
// repo resolved → the workflow falls back to the general route).
let codeRepoResolves = true;

const fakeActivities = {
  // Child RunnableWorkflow lifecycle fakes — the launched (abandoned) child needs
  // these to start + finalize cleanly. Returning an error from createWorkflowRun
  // makes the child fail fast (it's abandoned, so the parent is unaffected).
  cancelPendingHumanSteps: async () => {},
  // Phase B: code-route launch preparation. Returns null when codeRepoResolves is
  // false (no repo) so the workflow falls back to the general route; otherwise a
  // collision-free workflowId (the abandoned child's activities are faked).
  createChannelCodeTaskRun: async (input: { channelId: string; threadTs: string }) => {
    calls.codeTaskRuns.push(input);
    if (!codeRepoResolves) {
      return null;
    }
    return {
      request: {
        channelId: input.channelId,
        description: 'code task',
        externalTicketId: 't',
        repoId: 'repo-1',
        requestPayload: 'code task',
        workRequestId: 'ri-code',
      },
      templateId: 'tmpl-swe',
      templateVersion: 3,
      workflowId: `chantask-${input.channelId}-${input.threadTs}-${Math.random().toString(36).slice(2)}`,
    };
  },
  // Phase A: launch preparation. Returns a workflowId that can never collide with
  // a real run so the abandoned child RunnableWorkflow (started but not awaited)
  // doesn't interfere with other tests. The child's own activities are faked below.
  createChannelTaskRun: async (input: { channelId: string; threadTs: string }) => {
    calls.taskRuns.push(input);
    return {
      request: {
        description: 'task',
        externalTicketId: 't',
        repoId: '',
        requestPayload: 'task',
        workRequestId: 'ri-1',
      },
      templateId: 'tmpl-x',
      templateVersion: 1,
      workflowId: `chantask-${input.channelId}-${input.threadTs}-${Math.random().toString(36).slice(2)}`,
    };
  },
  createWorkflowRun: async () => ({ error: 'test child not run' }),
  finalizeChannelRun: async (args: FinalizeRunCall) => {
    calls.finalizeRuns.push(args);
  },
  finalizeWorkflowRun: async () => {},
  isChannelOverBudgetForTask: async (channelId: string) => {
    calls.budgetChecks.push(channelId);
    return overBudget;
  },
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
    return { delegate: turnDelegate, reply: turnReply };
  },
  startChannelRun: async (args: StartRunCall) => {
    calls.startRuns.push(args);
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
  calls.startRuns = [];
  calls.finalizeRuns = [];
  calls.taskRuns = [];
  calls.codeTaskRuns = [];
  calls.budgetChecks = [];
  placeholderTs = '999.000';
  placeholderThrows = false;
  turnThrows = false;
  turnReply = 'here is the answer';
  turnDelegate = undefined;
  overBudget = false;
  codeRepoResolves = true;
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

  it('creates the run record FIRST (keyed to the workflowId) then finalizes it SUCCESS', async () => {
    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-run-record'));

    // The run row is created keyed to the SAME Temporal workflowId that
    // currentWorkflowRunId() resolves — this is what makes the turn's agent
    // traces persist instead of silently no-op'ing.
    expect(calls.startRuns).toHaveLength(1);
    expect(calls.startRuns[0]).toMatchObject({
      channelId: 'chan-1',
      kind: 'mention',
      workflowId: 'ca-run-record',
    });
    expect(calls.finalizeRuns).toHaveLength(1);
    expect(calls.finalizeRuns[0]).toEqual({ status: 'SUCCESS', workflowId: 'ca-run-record' });
  }, 60_000);

  it('finalizes the run record FAILED when the turn errors (fallback still delivered)', async () => {
    turnThrows = true;

    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-run-failed'));

    expect(calls.startRuns).toHaveLength(1);
    expect(calls.finalizeRuns).toHaveLength(1);
    expect(calls.finalizeRuns[0]).toEqual({ status: 'FAILED', workflowId: 'ca-run-failed' });
    // The user still got the friendly fallback.
    expect(calls.updates[0]?.text).toContain('hit an error');
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

  // ── Phase A: general agentic task launch ────────────────────────────────────

  it('launches a task (prepares the run + checks budget) when the turn delegates', async () => {
    turnDelegate = { description: 'do the thing', route: 'general', title: 'Thing' };
    turnReply = 'On it — will follow up here.';

    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-delegate'));

    // Budget was checked, then the run was prepared (createChannelTaskRun → startChild).
    expect(calls.budgetChecks).toEqual(['chan-1']);
    expect(calls.taskRuns).toHaveLength(1);
    // The agent's ack is still posted to the user.
    expect(calls.updates[0]?.text).toBe('On it — will follow up here.');
  }, 60_000);

  it('does NOT launch a task when the turn does not delegate', async () => {
    turnDelegate = undefined;

    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-no-delegate'));

    expect(calls.budgetChecks).toHaveLength(0);
    expect(calls.taskRuns).toHaveLength(0);
    expect(calls.updates[0]?.text).toBe('here is the answer');
  }, 60_000);

  it('posts a budget notice and does NOT launch when the channel is over budget', async () => {
    turnDelegate = { description: 'do the thing', route: 'general', title: 'Thing' };
    overBudget = true;

    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-overbudget'));

    // Budget checked, but no run prepared.
    expect(calls.budgetChecks).toEqual(['chan-1']);
    expect(calls.taskRuns).toHaveLength(0);
    // The user gets the budget notice instead of the agent's ack.
    expect(calls.updates[0]?.text).toContain('monthly assistant budget');
  }, 60_000);

  // ── Phase B: code-task route via the SWE workflow ───────────────────────────

  it('routes a code delegate to the SWE launch when a repo resolves', async () => {
    turnDelegate = { description: 'add an endpoint', route: 'code', title: 'Endpoint' };
    turnReply = 'On it — will open a PR.';
    codeRepoResolves = true;

    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-code-ok'));

    // The code-route preparer ran; the general one did NOT (no fallback).
    expect(calls.codeTaskRuns).toHaveLength(1);
    expect(calls.taskRuns).toHaveLength(0);
    // The ack is posted unprefixed (no fallback note).
    expect(calls.updates[0]?.text).toBe('On it — will open a PR.');
  }, 60_000);

  it('falls back to the general route (with a note) when a code delegate resolves no repo', async () => {
    turnDelegate = { description: 'add an endpoint', route: 'code', title: 'Endpoint' };
    turnReply = 'On it — will follow up here.';
    codeRepoResolves = false;

    await env.client.workflow.execute('ChannelAssistantWorkflow', startArgs('ca-code-fallback'));

    // Code prep tried (returned null) → fell back to the general prep.
    expect(calls.codeTaskRuns).toHaveLength(1);
    expect(calls.taskRuns).toHaveLength(1);
    // The ack is prefixed with the no-repo note so the fallback isn't silent.
    expect(calls.updates[0]?.text).toContain("couldn't find a repository");
    expect(calls.updates[0]?.text).toContain('On it — will follow up here.');
  }, 60_000);
});
