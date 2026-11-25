/**
 * Workflow-level tests for `CampaignReconcilerWorkflow`, run in Temporal's time-skipping test
 * server against an in-memory world (`testing/campaignReconcilerWorld.ts`): fake activities that
 * read and write rows with the real ones' conditional semantics, so each test drives the real
 * workflow code and inspects the rows after.
 *
 * The suite skips itself when the test server cannot be started (no binary, no network).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAMPAIGN_ATTEMPT_FINISHED_SIGNAL,
  CAMPAIGN_CONTROL_SIGNAL,
  CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL,
  type CampaignReconcilerInput,
  type CampaignReconcilerResult,
} from '@auto-swe/shared/types/workflow';
import { Context } from '@temporalio/activity';
import proto from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type TestContext,
} from 'vitest';
import {
  finishAttempt,
  makeTarget,
  makeWorld,
  setPullRequest,
  states,
  T0,
  target,
  type World,
  worldActivities,
} from './testing/campaignReconcilerWorld.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASK_QUEUE = 'campaign-reconciler-test';
const CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';

type Handle = Awaited<ReturnType<TestWorkflowEnvironment['client']['workflow']['start']>>;
let world: World;
let seq = 0;
/** Each workflow acts on the world its test built, whatever test is running when it calls. */
const worldOf = new Map<string, World>();
const started: Handle[] = [];

/** The activities as registered: each call goes to whichever world the current test built. */
const ACTIVITY_NAMES = [
  'cancelCampaignAttempts',
  'discoverCampaignTargets',
  'finalizeCampaignReconciler',
  'planCampaignBriefs',
  'readCampaignPass',
  'recordCampaignPass',
  'runCampaignCheck',
  'startCampaignAttempt',
  'updateDomainState',
] as const;
const fakeActivities = Object.fromEntries(
  ACTIVITY_NAMES.map((name) => [
    name,
    (...args: unknown[]) => {
      const own = worldOf.get(Context.current().info.workflowExecution?.workflowId ?? '') ?? world;
      return (worldActivities(own)[name] as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  ])
);

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
});

afterEach(async () => {
  // A workflow a test left running ends the way a finished campaign does: its row says COMPLETED
  // and a signal wakes it. (Terminating one mid-activity left the time-skipping server unable to
  // skip for the next test.)
  for (const handle of started.splice(0)) {
    const own = worldOf.get(handle.workflowId);
    if (own) {
      own.campaign.state = 'COMPLETED';
    }
    await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'cancel' }).catch(() => undefined);
    await handle.result().catch(() => undefined);
  }
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

async function start(over: Partial<CampaignReconcilerInput> = {}): Promise<Handle> {
  seq += 1;
  const workflowId = `campaign-${CAMPAIGN_ID}-${seq}`;
  worldOf.set(workflowId, world);
  const signaller = (env as TestWorkflowEnvironment).client.workflow.getHandle(workflowId);
  world.signal = (name, arg) => signaller.signal(name, arg);
  const handle = await (env as TestWorkflowEnvironment).client.workflow.start(
    'CampaignReconcilerWorkflow',
    {
      args: [{ campaignId: CAMPAIGN_ID, campaignWorkflowId: workflowId, ...over }],
      taskQueue: TASK_QUEUE,
      workflowId,
    }
  );
  started.push(handle);
  return handle;
}

async function run(over: Partial<CampaignReconcilerInput> = {}) {
  const handle = await start(over);
  return { handle, result: (await handle.result()) as CampaignReconcilerResult };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!cond()) {
    throw new Error(`timed out waiting for ${what}`);
  }
}

/**
 * A run that finishes as it starts: its rows say so and its finish signal is sent before the start
 * activity returns, so the signal always lands while the workflow awaits that activity (never
 * during a workflow task, which the time-skipping test server completes unreliably).
 */
function finishesAfterStart(outcome: 'PR_OPENED' | 'NO_CHANGE' | 'FAILED', only?: string[]) {
  return async (t: { id: string; attemptN: number }, w: World) => {
    if (only && !only.includes(t.id)) {
      return;
    }
    finishAttempt(w, t.id, outcome, { failureReason: outcome === 'FAILED' ? 'boom' : undefined });
    await w.signal?.(CAMPAIGN_ATTEMPT_FINISHED_SIGNAL, { attemptN: t.attemptN, targetId: t.id });
  };
}

describe('CampaignReconcilerWorkflow', () => {
  it('works a campaign to COMPLETED, starting targets as the limit allows', async () => {
    world = makeWorld({
      campaign: { maxParallel: 2 },
      targets: [makeTarget('t1'), makeTarget('t2'), makeTarget('t3')],
    });
    world.onStart = finishesAfterStart('NO_CHANGE');
    const handle = await start();
    const result = (await handle.result()) as CampaignReconcilerResult;

    expect(result.status).toBe('COMPLETED');
    expect(states(world)).toEqual({ t1: 'SATISFIED', t2: 'SATISFIED', t3: 'SATISFIED' });
    expect(world.campaign.state).toBe('COMPLETED');
    // Position order, and never more than maxParallel in flight: t3 waited for one to finish.
    expect(world.starts.map((s) => s.targetId)).toEqual(['t1', 't2', 't3']);
    expect(world.finalized).toEqual(['COMPLETED']);
    expect(world.domainStates).toEqual(['FANNING_OUT', 'COMPLETED']);
    expect(result.passes).toBeGreaterThanOrEqual(2);
  });

  it('turns a merged pull request into SATISFIED by re-checking the base branch', async () => {
    world = makeWorld({
      campaign: { hasCheck: true },
      targets: [makeTarget('t1')],
    });
    world.onStart = finishesAfterStart('PR_OPENED');
    const handle = await start();

    await waitFor(() => target(world, 't1').state === 'PR_OPENED', 'the draft to open');
    // The draft is OPEN and nothing is checked yet.
    expect(world.checks).toEqual([]);
    setPullRequest(world, 't1', 'MERGED');
    await handle.signal(CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL, {
      runId: 'run-1',
      status: 'MERGED',
      targetId: 't1',
    });
    const result = (await handle.result()) as CampaignReconcilerResult;

    expect(result.status).toBe('COMPLETED');
    expect(world.checks).toEqual(['t1']);
    expect(states(world)).toEqual({ t1: 'SATISFIED' });
  });

  it('sends a merged target whose check still fails to NEEDS_ATTENTION and keeps the campaign ACTIVE', async () => {
    world = makeWorld({
      campaign: { hasCheck: true },
      targets: [
        makeTarget('t1', { attemptN: 1, prOpenedAt: T0, prStatus: 'MERGED', state: 'PR_OPENED' }),
      ],
    });
    world.checkAnswers.set('t1', ['not-satisfied']);
    await start();
    await waitFor(() => target(world, 't1').state === 'NEEDS_ATTENTION', 'the failed check');
    expect(world.campaign.state).toBe('ACTIVE');
    expect(target(world, 't1').failureReason).toBe('the check failed');
  });

  it('returns a regressed target to PENDING and starts it again', async () => {
    world = makeWorld({
      campaign: { hasCheck: true, hasScope: true, rescanIntervalHours: 24, state: 'MONITORING' },
      targets: [
        makeTarget('t1', { attemptN: 1, lastCheckedAt: T0 - 48 * 3_600_000, state: 'SATISFIED' }),
      ],
    });
    world.checkAnswers.set('t1', ['not-satisfied']);
    await start();
    await waitFor(() => world.starts.length === 1, 'the regressed target to start again');

    expect(world.checks).toEqual(['t1']);
    expect(world.starts[0]).toEqual({ attemptN: 2, targetId: 't1' });
    expect(target(world, 't1').regressions).toBe(1);
    // The campaign went back to ACTIVE before the gateway was asked to start anything.
    expect(world.campaign.state).toBe('ACTIVE');
  });

  it('holds a downstream target BLOCKED until the upstream is merged and checked (gate MERGED)', async () => {
    world = makeWorld({
      campaign: { gate: 'MERGED', hasCheck: true, maxParallel: 3 },
      targets: [makeTarget('t1'), makeTarget('t2', { dependsOn: ['t1'] })],
    });
    world.onStart = finishesAfterStart('PR_OPENED', ['t1']);
    const handle = await start();

    await waitFor(() => target(world, 't1').state === 'PR_OPENED', 't1 to open its draft');
    await waitFor(() => target(world, 't2').state === 'BLOCKED', 't2 to be blocked');
    expect(target(world, 't2').failureReason).toBe('Waiting for acme/t1');
    expect(world.starts.map((s) => s.targetId)).toEqual(['t1']);

    // t2 starts only after t1's pull request merged and its check passed.
    world.onStart = finishesAfterStart('NO_CHANGE', ['t2']);
    setPullRequest(world, 't1', 'MERGED');
    await handle.signal(CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL, {
      runId: 'run-1',
      status: 'MERGED',
      targetId: 't1',
    });
    const result = (await handle.result()) as CampaignReconcilerResult;
    expect(result.status).toBe('COMPLETED');
    expect(world.starts.map((s) => s.targetId)).toEqual(['t1', 't2']);
    expect(states(world)).toEqual({ t1: 'SATISFIED', t2: 'SATISFIED' });
  });

  it('starts nothing while PAUSED, lets a running attempt finish, and resumes', async () => {
    world = makeWorld({
      campaign: { maxParallel: 1 },
      targets: [makeTarget('t1'), makeTarget('t2')],
    });
    const handle = await start();
    await waitFor(() => world.starts.length === 1, 't1 to start');

    // A person pauses it: the route wrote the rows, then signalled.
    world.campaign.state = 'PAUSED';
    await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'pause' });
    // The running attempt finishes meanwhile; the pass records it and starts nothing.
    finishAttempt(world, 't1', 'NO_CHANGE');
    await handle.signal(CAMPAIGN_ATTEMPT_FINISHED_SIGNAL, { attemptN: 1, targetId: 't1' });
    await waitFor(
      () => target(world, 't1').state === 'SATISFIED',
      'the finished attempt to be recorded'
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(world.starts.map((s) => s.targetId)).toEqual(['t1']);
    // Held back by the limit while t1 ran (BLOCKED), and not started since.
    expect(['PENDING', 'BLOCKED']).toContain(target(world, 't2').state);

    world.onStart = finishesAfterStart('NO_CHANGE');
    world.campaign.state = 'ACTIVE';
    await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'resume' });
    const result = (await handle.result()) as CampaignReconcilerResult;
    expect(result.status).toBe('COMPLETED');
    expect(world.starts.map((s) => s.targetId)).toEqual(['t1', 't2']);
  });

  it('recovers a pull request change whose signal never arrived at the daily backstop', async () => {
    world = makeWorld({
      campaign: { hasCheck: true },
      targets: [
        makeTarget('t1', { attemptN: 1, prOpenedAt: T0, prStatus: 'OPEN', state: 'PR_OPENED' }),
      ],
      tick: 24 * 3_600_000,
    });
    // The merge happens between two reads and nobody signals.
    world.onRead = (n, w) => {
      if (n === 2) {
        setPullRequest(w, 't1', 'MERGED');
      }
    };
    const { result } = await run();
    expect(result.status).toBe('COMPLETED');
    expect(world.reads).toBeGreaterThanOrEqual(2);
    expect(states(world)).toEqual({ t1: 'SATISFIED' });
  });

  it('recovers a finished attempt whose signal was lost by polling while it is in flight', async () => {
    world = makeWorld({ targets: [makeTarget('t1')] });
    world.onRead = (n, w) => {
      if (n === 3) {
        finishAttempt(w, 't1', 'NO_CHANGE');
      }
    };
    const { result } = await run();
    expect(result.status).toBe('COMPLETED');
    expect(world.starts).toHaveLength(1);
  });

  it('continues as new carrying its counters, and keeps working', async () => {
    world = makeWorld({
      campaign: { hasCheck: true, hasScope: true, rescanIntervalHours: 24 },
      targets: [makeTarget('t1')],
      tick: 1000,
    });
    // t1 starts and its run never reports until read 205, so the reconciler polls (every five
    // minutes of workflow time) through 200 passes and continues as new.
    world.onRead = (n, w) => {
      if (n === 205) {
        finishAttempt(w, 't1', 'NO_CHANGE');
        w.campaign.hasScope = false;
      }
    };
    const { handle, result } = await run();
    expect(result.status).toBe('COMPLETED');
    // The pass counter crossed the continue-as-new: it is the sum over both executions.
    expect(result.passes).toBe(205);
    // Discovery ran once, before the continue-as-new, and the carried instant kept it from
    // running again in the next execution (its interval is 24 hours).
    expect(world.discoveries).toBe(1);
    const history = await (env as TestWorkflowEnvironment).client.workflow
      .getHandle(handle.workflowId, handle.firstExecutionRunId)
      .fetchHistory();
    expect(history.events?.at(-1)?.eventType).toBe(
      proto.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW
    );
  });

  it('plans a PLANNED campaign once, then waits for the launcher to confirm', async () => {
    world = makeWorld({
      campaign: { plan: 'PLANNED', state: 'PLANNING' },
      targets: [makeTarget('t1'), makeTarget('t2')],
    });
    world.onStart = finishesAfterStart('NO_CHANGE');
    const handle = await start();
    await waitFor(() => world.plans === 1, 'the plan');
    await new Promise((r) => setTimeout(r, 200));
    // Planned, but nothing starts until the confirm.
    expect(world.plans).toBe(1);
    expect(world.starts).toEqual([]);
    expect(world.campaign.state).toBe('PLANNING');

    world.campaign.state = 'ACTIVE';
    await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'confirm' });
    const result = (await handle.result()) as CampaignReconcilerResult;
    expect(result.status).toBe('COMPLETED');
    expect(world.plans).toBe(1);
    expect(world.starts.map((s) => s.targetId)).toEqual(['t1', 't2']);
  });

  it('does not loop on a planner that keeps failing: it waits for a person', async () => {
    world = makeWorld({
      campaign: { plan: 'PLANNED', state: 'PLANNING' },
      targets: [makeTarget('t1')],
    });
    world.failPlan = true;
    await start();
    await waitFor(() => world.plans >= 1, 'the plan attempt');
    await new Promise((r) => setTimeout(r, 300));
    expect(world.starts).toEqual([]);
    expect(world.campaign.state).toBe('PLANNING');
  });

  it('pauses a campaign whose kill switch turned off, and starts nothing', async () => {
    world = makeWorld({
      campaign: { campaignsEnabled: false },
      targets: [makeTarget('t1'), makeTarget('t2')],
    });
    await start();
    await waitFor(() => world.campaign.state === 'PAUSED', 'the pause');
    expect(world.pausedReason).toBe('disabled');
    expect(world.starts).toEqual([]);
  });

  it('pauses a campaign whose launcher is gone, and one that spent its budget', async () => {
    world = makeWorld({ campaign: { launcherAvailable: false }, targets: [makeTarget('t1')] });
    await start();
    await waitFor(() => world.campaign.state === 'PAUSED', 'the pause');
    expect(world.pausedReason).toBe('launcher-unavailable');

    world = makeWorld({ campaign: { budgetExceeded: true }, targets: [makeTarget('t1')] });
    await start();
    await waitFor(() => world.campaign.state === 'PAUSED', 'the pause');
    expect(world.pausedReason).toBe('budget');
    expect(world.starts).toEqual([]);
  });

  it('ends a target SKIPPED when the gateway says the launch no longer holds, and carries on', async () => {
    world = makeWorld({ targets: [makeTarget('t1'), makeTarget('t2')] });
    world.refusals.set('t1', { code: 'LAUNCH_REFUSED', message: 'the launcher lost access' });
    world.onStart = finishesAfterStart('NO_CHANGE');
    const handle = await start();
    const result = (await handle.result()) as CampaignReconcilerResult;
    expect(result.status).toBe('COMPLETED');
    expect(states(world)).toEqual({ t1: 'SKIPPED', t2: 'SATISFIED' });
    expect(target(world, 't1').failureReason).toBe('not started: the launcher lost access');
  });

  it('pauses the campaign when the gateway refuses a start for the kill switch or the budget', async () => {
    world = makeWorld({ targets: [makeTarget('t1'), makeTarget('t2')] });
    world.refusals.set('t1', { code: 'BUDGET_EXCEEDED', message: 'the budget is spent' });
    await start();
    await waitFor(() => world.campaign.state === 'PAUSED', 'the pause');
    expect(world.pausedReason).toBe('budget');
    // The refusal stops the pass: t2 was not tried.
    expect(world.starts).toEqual([]);
  });

  it('adds a discovered repository, and records one the launcher may not start work in', async () => {
    world = makeWorld({
      campaign: { hasCheck: true, hasScope: true, maxTargets: 10, rescanIntervalHours: 24 },
      targets: [makeTarget('t1', { attemptN: 1, lastCheckedAt: T0, state: 'SATISFIED' })],
    });
    world.discovery = [
      {
        connectionId: 'conn-new',
        label: 'acme/new',
        reachable: true,
        satisfied: false,
        teamId: 'team-a',
      },
      {
        connectionId: 'conn-other',
        label: 'other/repo',
        reachable: false,
        satisfied: false,
        teamId: 'team-b',
        unreachableReason: 'the launcher does not lead the team that owns the repository',
      },
      {
        connectionId: 'conn-fine',
        label: 'acme/fine',
        reachable: true,
        satisfied: true,
        teamId: 'team-a',
      },
    ];
    await start();
    await waitFor(() => world.starts.length === 1, 'the discovered target to start');
    expect(world.targets.map((t) => t.connectionId)).toEqual(['conn-t1', 'conn-new']);
    expect(world.proposalConnectionIds).toEqual(['conn-other']);
  });

  it('closes the rows of a cancelled campaign: attempts cancelled, then finalized', async () => {
    world = makeWorld({ targets: [makeTarget('t1'), makeTarget('t2')] });
    const handle = await start();
    await waitFor(() => world.starts.length === 2, 'both targets to start');
    world.campaign.state = 'CANCELLING';
    await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'cancel' });
    const result = (await handle.result()) as CampaignReconcilerResult;
    expect(result.status).toBe('CANCELLED');
    expect(world.cancelledAttempts).toBe(1);
    expect(world.finalized).toEqual(['CANCELLED']);
    expect(world.domainStates.at(-1)).toBe('CANCELLED');
    expect(states(world)).toEqual({ t1: 'CANCELLED', t2: 'CANCELLED' });
  });

  it('finalizes as cancelled when the workflow itself is cancelled', async () => {
    world = makeWorld({ targets: [makeTarget('t1')] });
    const handle = await start();
    await waitFor(() => world.starts.length === 1, 't1 to start');
    await handle.cancel();
    await expect(handle.result()).rejects.toThrow();
    expect(world.finalized).toEqual(['CANCELLED']);
    expect(world.cancelledAttempts).toBe(1);
  });

  it('stops at once for a campaign that is already final', async () => {
    world = makeWorld({ campaign: { state: 'COMPLETED' }, targets: [makeTarget('t1')] });
    const { result } = await run();
    expect(result.status).toBe('COMPLETED');
    expect(world.starts).toEqual([]);
  });

  it('flags a draft that crossed the stale threshold without changing its state', async () => {
    world = makeWorld({
      campaign: { staleAfterDays: 7 },
      targets: [
        makeTarget('t1', {
          attemptN: 1,
          prOpenedAt: T0 - 8 * 24 * 3_600_000,
          prStatus: 'OPEN',
          state: 'PR_OPENED',
        }),
      ],
    });
    await start();
    await waitFor(() => target(world, 't1').staleSince !== null, 'the stale flag');
    expect(target(world, 't1').staleSince).toBe(T0 - 8 * 24 * 3_600_000 + 7 * 24 * 3_600_000);
    expect(target(world, 't1').state).toBe('PR_OPENED');
    expect(world.starts).toEqual([]);
  });
});
