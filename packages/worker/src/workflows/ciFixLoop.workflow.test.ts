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
 *   A fix can also change nothing: the real session then makes no commit, the head stays
 *   the same, and no CI run starts (`noops` scripts that).
 * - `createOrUpdatePullRequest` pushes nothing. The first call creates the PR row; every
 *   later call only re-arms it (`headSha`, `ciStatus = PENDING`) and throws if it is
 *   handed a head that was not the latest push.
 * - A fake of the `/webhooks/ci` handler looks the PR row up BY HEAD SHA and drops a
 *   verdict for a head the row does not have yet, or whose verdict is no longer awaited
 *   (gateway/src/routes/webhooks.ts). A CI result for a head that was pushed but not yet
 *   re-armed is therefore lost, exactly as in production. One test holds the re-arm open
 *   to show the fake does drop such a verdict (and the run then waits out the CI timeout);
 *   in every other flow nothing is ever dropped.
 *
 * What this guards: a fix push is followed straight by the re-arm (only a status update
 * runs in between), so the fixed head's verdict finds its row; and a no-op fix never
 * waits for a CI event that cannot come.
 *
 * It also runs these two and the other repush engineering templates (`agent-reviewed-pr`,
 * `code-and-ci`, `dependency-update`) to an exhausted review or CI loop, through the real
 * `commitToMemory` step executor, to show the lesson is stored with the evidence the loop
 * kept rather than with none.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import {
  AGENT_REVIEWED_PR_SPEC,
  CODE_AND_CI_SPEC,
  CONSENSUS_REVIEW_SPEC,
  DEPENDENCY_UPDATE_SPEC,
  FOUR_EYES_SPEC,
} from '@auto-swe/shared/workflow';
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
interface HumanStep {
  context?: Record<string, unknown>;
  nodeId: string;
}
type CodeResultLike = { branch: string; headSha: string };

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
/** For each fix session, in call order: does it change nothing? Absent means it pushes. */
let noops: boolean[] = [];
/** The verdict for each reviewer slot, in call order; absent means approve. */
let reviewVerdicts: boolean[] = [];
/** Verdicts the webhook dropped, as "<sha>: <why>". */
let dropped: string[] = [];
/** The human steps created, with the context the person is shown. */
let humanSteps: HumanStep[] = [];
/** The rejection summary each review-fix session was given. */
let fixSummaries: string[] = [];
/** When set, a re-arm blocks until it resolves. */
let rearmGate: Promise<void> | null = null;
/** The evidence each `commitToMemory` call was handed, in call order. */
let lessons: Array<{ outcome: string; rejectionSummary?: string; ciFailure?: string }> = [];

function reset() {
  events = [];
  statuses = [];
  finalized = [];
  pr = null;
  lastPushed = '';
  pushes = 0;
  started = [];
  ciOutcomes = [];
  noops = [];
  reviewVerdicts = [];
  dropped = [];
  humanSteps = [];
  fixSummaries = [];
  rearmGate = null;
  lessons = [];
}

/** The implementation: pushes, and nothing tracks the head before the PR exists. */
function pushImplementation() {
  pushes += 1;
  lastPushed = `sha-${pushes}`;
  events.push('implement:push');
  return { branch: 'auto/T-1', headSha: lastPushed };
}

/** A fix session: commits and pushes only when it changed something. */
function fixSession(event: string, previous: CodeResultLike) {
  if (noops.shift()) {
    events.push(`${event}:noop`);
    return { ...previous };
  }
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
  commitToMemory: async (
    _workflowId: string,
    _repoId: string | null,
    _systemPrompt: string | undefined,
    evidence: { outcome: string; rejectionSummary?: string; ciFailure?: string }
  ) => {
    events.push(`lesson:${evidence.outcome}`);
    lessons.push(evidence);
    return 'lesson-1';
  },
  createHumanStep: async (input: { context?: Record<string, unknown>; nodeId?: string }) => {
    const nodeId = input.nodeId ?? '?';
    events.push(`humanStep:${nodeId}`);
    humanSteps.push({ context: input.context, nodeId });
  },
  // Pushes nothing: it creates the row, or re-arms it for the head the fix session pushed.
  createOrUpdatePullRequest: async (_request: unknown, codeResult: { headSha: string }) => {
    if (codeResult.headSha !== lastPushed) {
      throw new Error(`re-arm for ${codeResult.headSha}, but the head is ${lastPushed}`);
    }
    if (pr) {
      if (rearmGate) {
        events.push('rearm:waiting');
        await rearmGate;
      }
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
  executeCIFixImplementation: async (_failureContext: string, previous: CodeResultLike) =>
    fixSession('ciFix', previous),
  executeImplementation: async () => pushImplementation(),
  executeReviewFixImplementation: async (rejectionSummary: string, previous: CodeResultLike) => {
    fixSummaries.push(rejectionSummary);
    return fixSession('reviewFix', previous);
  },
  fetchCILogs: async () => {
    events.push('fetchLogs');
    return 'lint failed';
  },
  finalizeWorkflowRun: async (runId: string, status: string) => {
    finalized.push({ runId, status });
  },
  recordWorkflowStep: async () => {},
  resolveHumanStep: async () => {},
  // The local quality gates of code-and-ci and dependency-update.
  runLint: async () => ({ passed: true }),
  runReviewNetwork: async () => {
    const approved = reviewVerdicts.shift() ?? true;
    events.push(approved ? 'review' : 'review:reject');
    return { approved, rejectionSummary: approved ? '' : 'needs work', verdicts: [] };
  },
  runTests: async () => ({ passed: true }),
  runTypecheck: async () => ({ passed: true }),
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

type Step =
  | 'ci'
  | 'first:approve'
  | 'first:reject'
  | 'second:approve'
  | 'second:reject'
  | 'reason:text'
  | 'reason:empty'
  | 'reason:timeout';

const REASON = 'Add a test for the empty case';

/** Walk a run through the scripted CI results, sign-offs and rejection reasons, in order. */
async function drive(handle: Handle, steps: Step[]) {
  const round = { first: 0, reason: 0, second: 0 };
  for (const step of steps) {
    if (step === 'ci') {
      await ci(handle);
      continue;
    }
    if (step.startsWith('reason:')) {
      round.reason += 1;
      await until(
        `reason #${round.reason}`,
        () => count('humanStep:askRejectionReason') >= round.reason
      );
      await env.sleep('1 second');
      if (step === 'reason:timeout') {
        await env.sleep('2 hours');
      } else {
        const reason = step === 'reason:text' ? REASON : '';
        await handle.signal('hitl_askRejectionReason', { action: 'submit', value: { reason } });
      }
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

/** After the PR is open, a fix push is followed straight by the re-arm. */
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
const WHY = 'humanStep:askRejectionReason';
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
    // The approvers are shown the green head and the PR.
    expect(humanSteps.map((s) => s.context)).toEqual([
      expect.objectContaining({
        changedSinceLastSignoff: false,
        ciPassed: true,
        headSha: 'sha-1',
        noChangeMade: false,
        prUrl: 'https://example.test/pr/42',
        rejectedBefore: 0,
      }),
      expect.objectContaining({ headSha: 'sha-1' }),
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
    // The exhausted loop stores a lesson from the logs it kept, before the run ends.
    expect(lessons).toEqual([
      expect.objectContaining({ ciFailure: 'lint failed', outcome: 'CI_FAILED' }),
    ]);
    expect(events.at(-1)).toBe('lesson:CI_FAILED');
    expect(dropped).toEqual([]);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('counts a CI fix that changed nothing as a spent attempt and tries again, without waiting', async () => {
    // CI fails; the first fix changes nothing, so no CI event can follow it. The loop
    // goes round again (fetch logs, fix) instead of waiting for one.
    ciOutcomes = [false];
    noops = [true];
    const h = await run('fe-ci-noop');
    await drive(h, ['ci', 'ci', ...GREEN_HUMANS]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(events).toEqual([
      'implement:push',
      'review',
      'openPr',
      'fetchLogs',
      'ciFix:noop',
      'fetchLogs',
      'ciFix:push',
      'rearm',
      FIRST,
      SECOND,
    ]);
    expect(dropped).toEqual([]);
  }, 120_000);

  it('ends the run when CI fixes keep changing nothing, instead of waiting out the CI timeout', async () => {
    ciOutcomes = [false];
    noops = [true, true];
    const h = await run('fe-ci-noop-limit');
    await drive(h, ['ci']);
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(count('ciFix:noop')).toBe(2);
    expect(count('rearm')).toBe(0);
    expect(events.some((e) => e.startsWith('humanStep'))).toBe(false);
  }, 120_000);

  it('a rejection asks why, then goes fix -> CI -> BOTH sign-offs again, with new pending steps', async () => {
    const h = await run('fe-reject-first');
    await drive(h, ['ci', 'first:reject', 'reason:text', 'ci', ...GREEN_HUMANS]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(events).toEqual([
      'implement:push',
      'review',
      'openPr',
      FIRST,
      WHY,
      'reviewFix:push',
      'rearm',
      FIRST,
      SECOND,
    ]);
    // The reviewer's own words reach the fix session.
    expect(fixSummaries).toEqual([REASON]);
    expectRearmFollowsPushImmediately();
    expect(dropped).toEqual([]);
    // Round 2: the code changed, the approvers are told so, and shown the new head.
    const round2 = humanSteps.filter((s) => s.nodeId === 'firstSignoff')[1]?.context;
    expect(round2).toMatchObject({
      changedSinceLastSignoff: true,
      headSha: 'sha-2',
      noChangeMade: false,
      rejectedBefore: 1,
    });
  }, 120_000);

  it.each([
    ['gives an empty reason', 'reason:empty'],
    ['lets the question time out', 'reason:timeout'],
  ] as const)(
    'falls back to the generic text when the reviewer %s',
    async (_name, reason) => {
      const h = await run(`fe-reason-${reason}`);
      await drive(h, ['ci', 'first:reject', reason, 'ci', ...GREEN_HUMANS]);
      expect((await result(h)).status).toBe('SUCCESS');
      expect(fixSummaries).toHaveLength(1);
      expect(fixSummaries[0]).toContain('left no written reason');
    },
    120_000
  );

  it('does not reuse an earlier reason when the next rejection gives none', async () => {
    const h = await run('fe-reason-stale');
    await drive(h, [
      'ci',
      'first:reject',
      'reason:text',
      'ci',
      'first:reject',
      'reason:timeout',
      'ci',
      ...GREEN_HUMANS,
    ]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(fixSummaries[0]).toBe(REASON);
    expect(fixSummaries[1]).toContain('left no written reason');
  }, 120_000);

  it('an approval never carries over: rejecting at the second gate asks the first person again', async () => {
    const h = await run('fe-reject-second');
    await drive(h, ['ci', 'first:approve', 'second:reject', 'reason:text', 'ci', ...GREEN_HUMANS]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(count(FIRST)).toBe(2);
    expect(count(SECOND)).toBe(2);
    expect(events.indexOf('reviewFix:push')).toBeGreaterThan(events.indexOf(SECOND));
    expect(dropped).toEqual([]);
  }, 120_000);

  it('sends the same code back to both people, marked unchanged, when the fix changes nothing', async () => {
    // No commit, so the head is the one CI already passed and no CI event can follow: the
    // run goes straight back to the gate instead of waiting 4 h for one.
    noops = [true];
    const h = await run('fe-signoff-noop');
    await drive(h, ['ci', 'first:reject', 'reason:text', ...GREEN_HUMANS]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(events).toEqual([
      'implement:push',
      'review',
      'openPr',
      FIRST,
      WHY,
      'reviewFix:noop',
      FIRST,
      SECOND,
    ]);
    expect(count('rearm')).toBe(0);
    const round2 = humanSteps.filter((s) => s.nodeId === 'firstSignoff')[1]?.context;
    expect(round2).toMatchObject({
      changedSinceLastSignoff: false,
      headSha: 'sha-1',
      noChangeMade: true,
      rejectedBefore: 1,
    });
    expect(fixSummaries).toEqual([REASON]);
  }, 120_000);

  it('still fails on the third rejection when every fix changes nothing', async () => {
    noops = [true, true];
    const h = await run('fe-signoff-noop-limit');
    await drive(h, [
      'ci',
      'first:reject',
      'reason:text',
      'first:reject',
      'reason:text',
      'first:reject',
      'reason:text',
    ]);
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(count('reviewFix:noop')).toBe(2);
    expect(count('rearm')).toBe(0);
  }, 120_000);

  it('gives a fix after a rejection a fresh CI budget', async () => {
    // Round 1: CI fails once (1 of 3 used). Round 2, after a rejection: CI fails twice and
    // passes the third time, which a leftover counter would not allow.
    ciOutcomes = [false, true, false, false, true];
    const h = await run('fe-budget-reset');
    await drive(h, ['ci', 'ci', 'first:reject', 'reason:text', 'ci', 'ci', 'ci', ...GREEN_HUMANS]);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(count('ciFix:push')).toBe(3);
    expect(dropped).toEqual([]);
  }, 120_000);

  it('fails on the third rejection, after 2 fixes', async () => {
    const h = await run('fe-reject-limit');
    await drive(h, [
      'ci',
      'first:reject',
      'reason:text',
      'ci',
      'first:reject',
      'reason:text',
      'ci',
      'first:reject',
      'reason:text',
    ]);
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(r.prNumber).toBe(42);
    expect(count('reviewFix:push')).toBe(2);
    // People's rejections are not the review network's: the sign-off loop stores no lesson.
    expect(lessons).toEqual([]);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('stores a lesson when the agent review runs out of attempts, before any PR', async () => {
    reviewVerdicts = [false, false, false];
    const h = await run('fe-review-limit');
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(count('openPr')).toBe(0);
    expect(lessons).toEqual([
      expect.objectContaining({ outcome: 'REVIEW_FAILED', rejectionSummary: 'needs work' }),
    ]);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('keeps agent-review attempts and sign-off rejections as separate budgets', async () => {
    // Two agent rejections use 2 of the 3 review attempts before the PR exists; two human
    // rejections still fit their own budget of 3.
    reviewVerdicts = [false, false];
    const h = await run('fe-budgets');
    await drive(h, [
      'ci',
      'first:reject',
      'reason:text',
      'ci',
      'first:reject',
      'reason:text',
      'ci',
      ...GREEN_HUMANS,
    ]);
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
    expect(lessons).toEqual([
      expect.objectContaining({ ciFailure: 'lint failed', outcome: 'CI_FAILED' }),
    ]);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('counts a CI fix that changed nothing as a spent attempt, without waiting', async () => {
    ciOutcomes = [false];
    noops = [true, true];
    const h = await run('cr-ci-noop');
    await drive(h, ['ci']);
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(count('ciFix:noop')).toBe(2);
    expect(count('rearm')).toBe(0);
    expect(count('review')).toBe(0);
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

  it('hands a fix that changed nothing straight back to the reviewers, without waiting for CI', async () => {
    reviewVerdicts = [true, false];
    noops = [true];
    const h = await run('cr-fix-noop');
    await drive(h, ['ci']);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(normalised()).toEqual([
      'implement:push',
      'openPr',
      'review',
      'review',
      'reviewFix:noop',
      'review',
      'review',
    ]);
    expect(count('rearm')).toBe(0);
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
    // The consensus keeps its per-branch results, not one summary: the lesson still gets the
    // rejecting reviewer's text, not nothing.
    expect(lessons).toEqual([
      expect.objectContaining({ outcome: 'REVIEW_FAILED', rejectionSummary: 'needs work' }),
    ]);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);
});

// ── the repush templates: a loop that runs out stores a lesson first ─────────

describe.each([
  ['agent-reviewed-pr', AGENT_REVIEWED_PR_SPEC],
  ['code-and-ci', CODE_AND_CI_SPEC],
  ['dependency-update', DEPENDENCY_UPDATE_SPEC],
])('%s: failure lessons', (name, spec) => {
  const run = (id: string) => {
    currentSpec = spec as unknown as Record<string, unknown>;
    return start(`${name}-${id}`);
  };

  it('stores a CI_FAILED lesson from the kept logs when CI runs out of fixes', async () => {
    ciOutcomes = [false, false, false];
    const h = await run('ci-limit');
    await drive(h, ['ci', 'ci', 'ci']);
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(r.prNumber).toBe(42);
    expect(count('ciFix:push')).toBe(2);
    expect(lessons).toEqual([
      expect.objectContaining({ ciFailure: 'lint failed', outcome: 'CI_FAILED' }),
    ]);
    expect(events.at(-1)).toBe('lesson:CI_FAILED');
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('stores no lesson when the run succeeds', async () => {
    const h = await run('green');
    await drive(h, ['ci']);
    expect((await result(h)).status).toBe('SUCCESS');
    expect(lessons).toEqual([]);
  }, 120_000);
});

describe('agent-reviewed-pr: failure lessons', () => {
  it('stores a REVIEW_FAILED lesson from the last rejection when the review runs out', async () => {
    reviewVerdicts = [false, false, false];
    currentSpec = AGENT_REVIEWED_PR_SPEC as unknown as Record<string, unknown>;
    const h = await start('agent-reviewed-pr-review-limit');
    const r = await result(h);
    expect(r.status).toBe('FAILED');
    expect(count('openPr')).toBe(0);
    expect(lessons).toEqual([
      expect.objectContaining({ outcome: 'REVIEW_FAILED', rejectionSummary: 'needs work' }),
    ]);
  }, 120_000);
});

// ── the fake the "nothing is dropped" assertions rely on ─────────────────────

describe('the CI webhook fake', () => {
  it('drops a verdict for a head the PR row has not been armed for', async () => {
    pr = { ciStatus: 'PENDING', headSha: 'sha-1' };
    const outcome = await ciWebhook({ signal: async () => {} } as unknown as Handle, {
      passed: true,
      sha: 'sha-2',
    });
    expect(outcome).toBe('dropped');
    expect(dropped).toEqual(['sha-2: no tracked PR for this commit']);
  });

  it('loses the verdict of a fixed head that finishes before the re-arm, and the run waits out the CI timeout', async () => {
    // Hold the re-arm open and let the fixed head's CI finish in that gap: the verdict has
    // no row to land on, which is the failure the real flows avoid by re-arming straight
    // after the push. Nothing sends another event, so the CI wait times out.
    currentSpec = FOUR_EYES_SPEC as unknown as Record<string, unknown>;
    ciOutcomes = [false];
    let release = () => {};
    rearmGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await start('fe-dropped-verdict');
    await ci(h);
    await until('the re-arm to be waiting', () => count('rearm:waiting') === 1);
    const fixedHead = started.shift() as CiRun;
    expect(await ciWebhook(h, fixedHead)).toBe('dropped');
    expect(dropped).toEqual([`${fixedHead.sha}: no tracked PR for this commit`]);
    release();
    const r = await result(h);
    expect(r.status).toBe('TIMED_OUT');
    expect(events.some((e) => e.startsWith('humanStep'))).toBe(false);
  }, 120_000);
});
