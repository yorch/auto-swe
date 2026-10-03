/**
 * `consensus-review` and `four-eyes` run CI, and fix a failing CI, BEFORE their human
 * sign-offs / reviewer consensus, so the gate sees exactly the code that is on the pull
 * request and CI is green on it. These run the REAL seeded specs through the real
 * RunnableWorkflow in Temporal's time-skipping test server.
 *
 * The fakes keep the production split of duties instead of hiding it:
 *
 * - `executeImplementation`, `executeCIFixImplementation` and
 *   `executeReviewFixImplementation` PUSH a new head (the real fix sessions run
 *   `git push` themselves) and start a CI run for it, like a `pull_request`-triggered CI.
 * - `createOrUpdatePullRequest` pushes nothing. The first call creates the PR row; every
 *   later call only re-arms it (`headSha`, `ciStatus = PENDING`) and throws if it is
 *   handed a head that was not the latest push.
 * - A fake of the `/webhooks/ci` handler looks the PR row up BY HEAD SHA and drops a
 *   verdict for a head the row does not have yet, or whose verdict is no longer awaited
 *   (gateway/src/routes/webhooks.ts). A CI result for a head that was pushed but not yet
 *   re-armed is therefore lost, exactly as in production.
 *
 * The race this guards: with human or review time between the fix push and the re-arm, the
 * fixed head's verdict is dropped and the run waits out the 4 h CI timeout. Here the
 * re-arm is the very next activity after the push, and the tests assert that nothing runs
 * between them and that no verdict is ever dropped.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { CONSENSUS_REVIEW_SPEC, FOUR_EYES_SPEC } from '@auto-swe/shared/workflow';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

const TASK_QUEUE = 'ci-fix-loop-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── World state, reset per test ──────────────────────────────────────────────

interface PrRow {
  ciStatus: 'PENDING' | 'PASSED' | 'FAILED';
  headSha: string;
}
interface CiRun {
  passed: boolean;
  sha: string;
}

/** Everything the fakes saw, in order. */
let events: string[] = [];
let statuses: string[] = [];
let finalized: Array<{ runId: string; status: string }> = [];
let currentSpec: Record<string, unknown> = {};
let pr: PrRow | null = null;
let lastPushed = '';
let pushes = 0;
/** CI runs started by a push or the PR opening and not yet delivered, oldest first. */
let started: CiRun[] = [];
/** The outcome of each CI run, in the order the runs start; absent means it passes. */
let ciOutcomes: boolean[] = [];
/** The verdict for each reviewer slot, in call order; absent means approve. */
let reviewVerdicts: boolean[] = [];
/** Verdicts the webhook dropped, as "<sha>: <why>". */
let dropped: string[] = [];

function reset() {
  events = [];
  statuses = [];
  finalized = [];
  pr = null;
  lastPushed = '';
  pushes = 0;
  started = [];
  ciOutcomes = [];
  reviewVerdicts = [];
  dropped = [];
}

function push(event: string) {
  pushes += 1;
  lastPushed = `sha-${pushes}`;
  events.push(`${event}:push`);
  // A push starts CI only once the PR exists; before that nothing tracks the head.
  if (pr) {
    started.push({ passed: ciOutcomes.shift() ?? true, sha: lastPushed });
  }
  return { branch: 'auto/T-1', headSha: lastPushed };
}

const fakeActivities = {
  cancelPendingHumanSteps: async () => {},
  createHumanStep: async (input: { nodeId?: string }) => {
    events.push(`humanStep:${input.nodeId ?? '?'}`);
  },
  // Pushes nothing: it creates the row, or re-arms it for the head the fix session pushed.
  createOrUpdatePullRequest: async (_request: unknown, codeResult: { headSha: string }) => {
    if (codeResult.headSha !== lastPushed) {
      throw new Error(`re-arm for ${codeResult.headSha}, but the head is ${lastPushed}`);
    }
    if (pr) {
      events.push('rearm');
      pr = { ciStatus: 'PENDING', headSha: codeResult.headSha };
    } else {
      events.push('openPr');
      pr = { ciStatus: 'PENDING', headSha: codeResult.headSha };
      started.push({ passed: ciOutcomes.shift() ?? true, sha: codeResult.headSha });
    }
    return { prNumber: 42, prUrl: 'https://example.test/pr/42' };
  },
  createWorkflowRun: async () => ({
    pinnedSettings: undefined,
    runId: 'run-test-1',
    spec: currentSpec,
  }),
  executeCIFixImplementation: async () => push('ciFix'),
  executeImplementation: async () => push('implement'),
  executeReviewFixImplementation: async () => push('reviewFix'),
  fetchCILogs: async () => {
    events.push('fetchLogs');
    return 'lint failed';
  },
  finalizeWorkflowRun: async (runId: string, status: string) => {
    finalized.push({ runId, status });
  },
  recordWorkflowStep: async () => {},
  resolveHumanStep: async () => {},
  runReviewNetwork: async () => {
    const approved = reviewVerdicts.shift() ?? true;
    events.push(approved ? 'review' : 'review:reject');
    return { approved, rejectionSummary: approved ? '' : 'needs work', verdicts: [] };
  },
  storeContextOverflowBatch: async () => [],
  updateDomainState: async (_workflowId: string, status: string) => {
    statuses.push(status);
  },
  validateContext: async () => ({ contextSnapshotId: 'cs-1', successCriteria: ['builds'] }),
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
  reset();
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

const REQUEST = {
  budgetTier: 'STANDARD' as const,
  description: 'test',
  externalTicketId: 'T-1',
  repoId: '00000000-0000-4000-8000-000000000001',
  requestPayload: '{}',
  workRequestId: '00000000-0000-4000-8000-000000000002',
} satisfies RepoWorkRequest;

type Handle = Awaited<ReturnType<typeof start>>;

function start(workflowId: string) {
  return env.client.workflow.start('RunnableWorkflow', {
    args: [{ request: REQUEST, templateId: 'tpl-1', templateVersion: 1 }],
    taskQueue: TASK_QUEUE,
    workflowExecutionTimeout: '4 days',
    workflowId,
  });
}

async function until(label: string, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(cond(), `timed out waiting for ${label}; saw ${events.join(',')}`).toBe(true);
}

const count = (name: string) => events.filter((e) => e === name).length;

/**
 * The fake `/webhooks/ci` handler: finds the PR row by head sha, drops a verdict nobody is
 * awaiting for that head, otherwise records it and signals the run.
 */
async function ciWebhook(handle: Handle, run: CiRun): Promise<'signalled' | 'dropped'> {
  if (!pr || pr.headSha !== run.sha) {
    dropped.push(`${run.sha}: no tracked PR for this commit`);
    return 'dropped';
  }
  if (pr.ciStatus !== 'PENDING') {
    dropped.push(`${run.sha}: verdict already recorded`);
    return 'dropped';
  }
  pr.ciStatus = run.passed ? 'PASSED' : 'FAILED';
  await handle.signal('ciPipelineSignal', {
    logsUrl: 'https://ci.test/logs/1',
    passed: run.passed,
  });
  return 'signalled';
}

/** Deliver the oldest started CI run once the PR row is armed for its head. */
async function ci(handle: Handle) {
  await until('a CI run to start', () => started.length > 0);
  const run = started[0] as CiRun;
  await until(`the PR row to be armed for ${run.sha}`, () => pr?.headSha === run.sha);
  started.shift();
  await env.sleep('1 second');
  expect(await ciWebhook(handle, run)).toBe('signalled');
}

type Step = 'ci' | 'first:approve' | 'first:reject' | 'second:approve' | 'second:reject';

/** Walk a run through the scripted CI results and sign-offs, in order. */
async function drive(handle: Handle, steps: Step[]) {
  const round = { first: 0, second: 0 };
  for (const step of steps) {
    if (step === 'ci') {
      await ci(handle);
      continue;
    }
    const [who, action] = step.split(':') as ['first' | 'second', 'approve' | 'reject'];
    round[who] += 1;
    const node = `${who}Signoff`;
    await until(`${node} #${round[who]}`, () => count(`humanStep:${node}`) >= round[who]);
    await env.sleep('1 second');
    await handle.signal(`hitl_${node}`, { action });
  }
}

/** The two reviewer slots run concurrently, so which one rejects is not ordered. */
const normalised = () => events.map((e) => (e === 'review:reject' ? 'review' : e));

const result = async (handle: Handle) =>
  (await handle.result()) as { prNumber?: number; status: string };

/** Nothing ran between a push and the re-arm that follows it. */
function expectRearmFollowsPushImmediately() {
  const opened = events.indexOf('openPr');
  events.forEach((e, i) => {
    if (e.endsWith(':push') && i > opened) {
      expect(events[i + 1], `after ${e}`).toBe('rearm');
    }
  });
}

const FIRST = 'humanStep:firstSignoff';
const SECOND = 'humanStep:secondSignoff';
const GREEN_HUMANS = ['first:approve', 'second:approve'] as const;

// ── four-eyes ────────────────────────────────────────────────────────────────

describe('four-eyes: CI first, then two sign-offs on the green code', () => {
  const run = (id: string) => {
    currentSpec = FOUR_EYES_SPEC as unknown as Record<string, unknown>;
    return start(id);
  };

  it('opens the PR, passes CI, then asks both people', async () => {
    const h = await run('fe-green');
    await drive(h, ['ci', ...GREEN_HUMANS]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(events).toEqual(['implement:push', 'review', 'openPr', FIRST, SECOND]);
    expect(statuses).toEqual([
      'VALIDATING_CONTEXT',
      'IMPLEMENTING',
      'IN_REVIEW',
      'AWAITING_CI',
      'IN_REVIEW',
    ]);
  }, 120_000);

  it('fixes a failing CI before any human is asked, and loses no verdict', async () => {
    ciOutcomes = [false];
    const h = await run('fe-ci-once');
    await drive(h, ['ci', 'ci', ...GREEN_HUMANS]);
    const r = await result(h);
    expect(r.status).toBe('SUCCESS');
    expect(r.prNumber).toBe(42);
    expect(events).toEqual([
      'implement:push',
      'review',
      'openPr',
      'fetchLogs',
      'ciFix:push',
      'rearm',
      FIRST,
      SECOND,
    ]);
    expectRearmFollowsPushImmediately();
    expect(dropped).toEqual([]);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'SUCCESS' });
  }, 120_000);

  it('fails after 3 CI failures (2 fixes) without ever asking a human', async () => {
    ciOutcomes = [false, false, false];
    const h = await run('fe-ci-limit');
    await drive(h, ['ci', 'ci', 'ci']);
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(r.prNumber).toBe(42);
    expect(count('ciFix:push')).toBe(2);
    expect(events.some((e) => e.startsWith('humanStep'))).toBe(false);
    expect(dropped).toEqual([]);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('a rejection goes fix -> CI -> BOTH sign-offs again, with new pending steps', async () => {
    const h = await run('fe-reject-first');
    await drive(h, ['ci', 'first:reject', 'ci', ...GREEN_HUMANS]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(events).toEqual([
      'implement:push',
      'review',
      'openPr',
      FIRST,
      'reviewFix:push',
      'rearm',
      FIRST,
      SECOND,
    ]);
    expectRearmFollowsPushImmediately();
    expect(dropped).toEqual([]);
  }, 120_000);

  it('an approval never carries over: rejecting at the second gate asks the first person again', async () => {
    const h = await run('fe-reject-second');
    await drive(h, ['ci', 'first:approve', 'second:reject', 'ci', ...GREEN_HUMANS]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(count(FIRST)).toBe(2);
    expect(count(SECOND)).toBe(2);
    expect(events.indexOf('reviewFix:push')).toBeGreaterThan(events.indexOf(SECOND));
    expect(dropped).toEqual([]);
  }, 120_000);

  it('gives a fix after a rejection a fresh CI budget', async () => {
    // Round 1: CI fails once (1 of 3 used). Round 2, after a rejection: CI fails twice and
    // passes the third time, which a leftover counter would not allow.
    ciOutcomes = [false, true, false, false, true];
    const h = await run('fe-budget-reset');
    await drive(h, ['ci', 'ci', 'first:reject', 'ci', 'ci', 'ci', ...GREEN_HUMANS]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(count('ciFix:push')).toBe(3);
    expect(dropped).toEqual([]);
  }, 120_000);

  it('fails on the third rejection, after 2 fixes', async () => {
    const h = await run('fe-reject-limit');
    await drive(h, ['ci', 'first:reject', 'ci', 'first:reject', 'ci', 'first:reject']);
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(r.prNumber).toBe(42);
    expect(count('reviewFix:push')).toBe(2);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('keeps agent-review attempts and sign-off rejections as separate budgets', async () => {
    // Two agent rejections use 2 of the 3 review attempts before the PR exists; two human
    // rejections still fit their own budget of 3.
    reviewVerdicts = [false, false];
    const h = await run('fe-budgets');
    await drive(h, ['ci', 'first:reject', 'ci', 'first:reject', 'ci', ...GREEN_HUMANS]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(count('reviewFix:push')).toBe(4);
  }, 120_000);

  it('times out when nobody signs off', async () => {
    const h = await run('fe-timeout');
    await drive(h, ['ci']);
    const r = await result(h);
    expect(r.status).toBe('TIMED_OUT');
    expect(r.prNumber).toBe(42);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'TIMED_OUT' });
  }, 120_000);
});

// ── consensus-review ─────────────────────────────────────────────────────────

describe('consensus-review: CI first, then two reviewers on the green code', () => {
  const run = (id: string) => {
    currentSpec = CONSENSUS_REVIEW_SPEC as unknown as Record<string, unknown>;
    return start(id);
  };

  it('opens the PR and passes CI before either reviewer runs', async () => {
    const h = await run('cr-green');
    await drive(h, ['ci']);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(events).toEqual(['implement:push', 'openPr', 'review', 'review']);
    // The status says what the run is doing: CI first, then reviewing.
    expect(statuses).toEqual(['VALIDATING_CONTEXT', 'IMPLEMENTING', 'AWAITING_CI', 'IN_REVIEW']);
  }, 120_000);

  it('fixes a failing CI before the reviewers run, and loses no verdict', async () => {
    ciOutcomes = [false];
    const h = await run('cr-ci-once');
    await drive(h, ['ci', 'ci']);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(events).toEqual([
      'implement:push',
      'openPr',
      'fetchLogs',
      'ciFix:push',
      'rearm',
      'review',
      'review',
    ]);
    expectRearmFollowsPushImmediately();
    expect(dropped).toEqual([]);
  }, 120_000);

  it('fails after 3 CI failures (2 fixes) without running a reviewer', async () => {
    ciOutcomes = [false, false, false];
    const h = await run('cr-ci-limit');
    await drive(h, ['ci', 'ci', 'ci']);
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(r.prNumber).toBe(42);
    expect(count('ciFix:push')).toBe(2);
    expect(count('review')).toBe(0);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('a rejection goes fix -> CI -> both reviewers again', async () => {
    reviewVerdicts = [true, false];
    const h = await run('cr-reject');
    await drive(h, ['ci', 'ci']);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(normalised()).toEqual([
      'implement:push',
      'openPr',
      'review',
      'review',
      'reviewFix:push',
      'rearm',
      'review',
      'review',
    ]);
    expect(count('review:reject')).toBe(1);
    expect(statuses).toEqual([
      'VALIDATING_CONTEXT',
      'IMPLEMENTING',
      'AWAITING_CI',
      'IN_REVIEW',
      'AWAITING_CI',
      'IN_REVIEW',
    ]);
    expectRearmFollowsPushImmediately();
    expect(dropped).toEqual([]);
  }, 120_000);

  it('shares one 3-attempt consensus budget across CI rounds', async () => {
    // Every round, one reviewer rejects: round 3 ends the run after only 2 fixes.
    reviewVerdicts = [false, true, false, true, false, true];
    const h = await run('cr-reject-limit');
    await drive(h, ['ci', 'ci', 'ci']);
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(r.prNumber).toBe(42);
    expect(count('reviewFix:push')).toBe(2);
    expect(count('review') + count('review:reject')).toBe(6);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);
});

// ── the fake the race test relies on ─────────────────────────────────────────

describe('the CI webhook fake', () => {
  it('drops a verdict for a head the PR row has not been armed for', async () => {
    // If a template let time pass between the fix push and the re-arm, this is what would
    // happen to the fixed head's verdict, and the run would wait out the 4 h CI timeout.
    pr = { ciStatus: 'PENDING', headSha: 'sha-1' };
    const outcome = await ciWebhook({ signal: async () => {} } as unknown as Handle, {
      passed: true,
      sha: 'sha-2',
    });
    expect(outcome).toBe('dropped');
    expect(dropped).toEqual(['sha-2: no tracked PR for this commit']);
  });
});
