/**
 * Records the execution histories `campaignReconciler.replay.test.ts` replays against current
 * `CampaignReconcilerWorkflow` code, one fixture per control-flow shape: reconcile to completion, a
 * gate that holds a target BLOCKED, a pause and a resume, a wake by a pull-request signal, a
 * regression, `continueAsNew`, a cancel (by the campaign row and by the workflow's own
 * cancellation), planning and a confirm, a chunked discovery walk, a pause by a refusal, and a
 * failed check.
 *
 * A separate script from `recordReplayHistory.ts` on purpose: the reconciler's fixtures live in
 * their own directory (`__fixtures__/campaign-reconciler/`), so the replay suites of the other
 * workflows, which read every `.bin` beside them, never see them, and recording one of these
 * cannot rewrite one of those.
 *
 * Run this **only** to add a scenario or when the reconciler's structure changed intentionally.
 * Regenerating a fixture to make a failing replay pass defeats its purpose: a determinism
 * violation is exactly what the replay is for. Change the reconciler's scheduling behind
 * `patched('campaign-…')` instead.
 *
 *   yarn workspace @auto-swe/worker exec tsx scripts/recordCampaignReconcilerHistory.ts [scenario ...]
 *
 * With no arguments every scenario is recorded; name scenarios to record only those. A scenario
 * whose fixture already exists is refused unless it is named on the command line.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAMPAIGN_ATTEMPT_FINISHED_SIGNAL,
  CAMPAIGN_CONTROL_SIGNAL,
  CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL,
} from '@auto-swe/shared/types/workflow';
import proto from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import {
  finishAttempt,
  makeTarget,
  makeWorld,
  setPullRequest,
  T0,
  target,
  type World,
  worldActivities,
} from '../src/workflows/testing/campaignReconcilerWorld.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = path.resolve(__dirname, '../src/workflows/index.ts');
const OUT_DIR = path.resolve(__dirname, '../src/workflows/__fixtures__/campaign-reconciler');

const CAMPAIGN_ID = '77777777-7777-4777-8777-777777777777';
const EventType = proto.temporal.api.enums.v1.EventType;

interface Handle {
  workflowId: string;
  firstExecutionRunId: string;
  signal(name: string, arg?: unknown): Promise<void>;
  result(): Promise<unknown>;
  fetchHistory(): Promise<proto.temporal.api.history.v1.IHistory>;
}

interface Scenario {
  name: string;
  world: () => World;
  /** Drives the run from outside (signals the world cannot send itself). */
  drive?: (handle: Handle, world: World) => Promise<void>;
  /** Record the first execution only (a workflow that continues as new). */
  firstExecutionOnly?: boolean;
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!cond()) {
    throw new Error(`timed out waiting for ${what}`);
  }
  // Give the worker a beat to park on its condition.
  await new Promise((r) => setTimeout(r, 400));
}

/** A run that finishes as it starts, and says so before the start activity returns. */
const finishesOnStart =
  (outcome: 'PR_OPENED' | 'NO_CHANGE', only?: string[]) =>
  async (t: { id: string; attemptN: number }, w: World) => {
    if (only && !only.includes(t.id)) {
      return;
    }
    finishAttempt(w, t.id, outcome);
    await w.signal?.(CAMPAIGN_ATTEMPT_FINISHED_SIGNAL, { attemptN: t.attemptN, targetId: t.id });
  };

const SCENARIOS: Scenario[] = [
  {
    // Three targets under maxParallel 2, each finishing with no change: t3 starts only after one of
    // the first two finished, and the campaign completes.
    name: 'complete',
    world: () => {
      const w = makeWorld({
        campaign: { maxParallel: 2 },
        targets: [makeTarget('t1'), makeTarget('t2'), makeTarget('t3')],
      });
      w.onStart = finishesOnStart('NO_CHANGE');
      return w;
    },
  },
  {
    drive: async (handle, w) => {
      await waitFor(
        () => target(w, 't1').state === 'PR_OPENED' && target(w, 't2').state === 'BLOCKED',
        't2 to be blocked behind t1'
      );
      w.onStart = finishesOnStart('NO_CHANGE', ['t2']);
      setPullRequest(w, 't1', 'MERGED');
      await handle.signal(CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL, {
        runId: 'run-t1',
        status: 'MERGED',
        targetId: 't1',
      });
    },
    // Gate MERGED: t2 waits BLOCKED behind t1's draft. A pull-request signal wakes the reconciler
    // when t1 merges; its check passes, t2 starts and the campaign completes.
    name: 'gate-blocked',
    world: () => {
      const w = makeWorld({
        campaign: { gate: 'MERGED', hasCheck: true, maxParallel: 3 },
        targets: [makeTarget('t1'), makeTarget('t2', { dependsOn: ['t1'] })],
      });
      w.onStart = finishesOnStart('PR_OPENED', ['t1']);
      return w;
    },
  },
  {
    drive: async (handle, w) => {
      await waitFor(() => w.starts.length === 1, 't1 to start');
      w.campaign.state = 'PAUSED';
      await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'pause' });
      finishAttempt(w, 't1', 'NO_CHANGE');
      await handle.signal(CAMPAIGN_ATTEMPT_FINISHED_SIGNAL, { attemptN: 1, targetId: 't1' });
      await waitFor(() => target(w, 't1').state === 'SATISFIED', 't1 to be recorded');
      w.onStart = finishesOnStart('NO_CHANGE');
      w.campaign.state = 'ACTIVE';
      await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'resume' });
    },
    // A person pauses the campaign while t1 runs: its attempt finishes and is recorded, t2 is not
    // started, and a resume signal lets it go on to completion.
    name: 'pause-resume',
    world: () =>
      makeWorld({ campaign: { maxParallel: 1 }, targets: [makeTarget('t1'), makeTarget('t2')] }),
  },
  {
    drive: async (handle, w) => {
      await waitFor(() => w.reads >= 1, 'the first pass');
      setPullRequest(w, 't1', 'MERGED');
      await handle.signal(CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL, {
        runId: 'run-t1',
        status: 'MERGED',
        targetId: 't1',
      });
    },
    // An open draft is merged and the webhook's signal wakes the reconciler, which re-checks the
    // base branch and finishes the target.
    name: 'pull-request-signal',
    world: () =>
      makeWorld({
        campaign: { hasCheck: true },
        targets: [
          makeTarget('t1', { attemptN: 1, prOpenedAt: T0, prStatus: 'OPEN', state: 'PR_OPENED' }),
        ],
      }),
  },
  {
    // A satisfied target's rescan finds the goal no longer holds: it returns to PENDING, starts
    // again, and finishes; with the scope removed the campaign then completes.
    name: 'regression',
    world: () => {
      const w = makeWorld({
        campaign: { hasCheck: true, hasScope: true, rescanIntervalHours: 24, state: 'MONITORING' },
        targets: [
          makeTarget('t1', { attemptN: 1, lastCheckedAt: T0 - 48 * 3_600_000, state: 'SATISFIED' }),
        ],
      });
      w.checkAnswers.set('t1', ['not-satisfied']);
      w.onStart = async (t, world) => {
        world.campaign.hasScope = false;
        await finishesOnStart('NO_CHANGE')(t, world);
      };
      return w;
    },
  },
  {
    firstExecutionOnly: true,
    // 205 passes of an attempt that never reports: the reconciler polls, continues as new after
    // 200 passes carrying its counters, and the recording is the first execution, closed as
    // ContinuedAsNew.
    name: 'continue-as-new',
    world: () => {
      const w = makeWorld({
        campaign: { hasCheck: true, hasScope: true, rescanIntervalHours: 24 },
        targets: [makeTarget('t1')],
        tick: 1000,
      });
      w.onRead = (n, world) => {
        if (n === 205) {
          finishAttempt(world, 't1', 'NO_CHANGE');
          world.campaign.hasScope = false;
        }
      };
      return w;
    },
  },
  {
    // The gateway's cancel route: the row says CANCELLING and a control signal wakes the
    // reconciler, which cancels the attempt in flight, closes the rows and ends.
    drive: async (handle, w) => {
      await waitFor(() => w.starts.length === 1, 't1 to start');
      w.campaign.state = 'CANCELLING';
      await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'cancel' });
    },
    name: 'cancel',
    world: () =>
      makeWorld({ campaign: { maxParallel: 1 }, targets: [makeTarget('t1'), makeTarget('t2')] }),
  },
  {
    // The workflow itself is cancelled (handle.cancel()): same closing of the rows, and the
    // execution ends cancelled.
    drive: async (handle, w) => {
      await waitFor(() => w.starts.length === 1, 't1 to start');
      await (handle as unknown as { cancel(): Promise<void> }).cancel();
    },
    name: 'cancel-workflow',
    world: () =>
      makeWorld({ campaign: { maxParallel: 1 }, targets: [makeTarget('t1'), makeTarget('t2')] }),
  },
  {
    // A planned campaign is decomposed once, then waits in PLANNING (nothing starts) until its
    // launcher confirms; after the confirm both targets run and the campaign completes.
    drive: async (handle, w) => {
      await waitFor(() => w.plans === 1 && w.planned, 'the plan to be written');
      w.onStart = finishesOnStart('NO_CHANGE');
      w.campaign.state = 'ACTIVE';
      await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'confirm' });
    },
    name: 'planning-confirm',
    world: () =>
      makeWorld({
        campaign: { plan: 'PLANNED', state: 'PLANNING' },
        targets: [makeTarget('t1'), makeTarget('t2')],
      }),
  },
  {
    // A walk of the scope in two chunks: each chunk's findings are written as it is read, a
    // reachable repository is added at the end and one the launcher cannot start work in is
    // recorded as a proposal; once the walk is done the scope is taken away so the campaign ends.
    name: 'discovery',
    world: () => {
      const w = makeWorld({
        campaign: { hasCheck: true, hasScope: true, maxTargets: 10, rescanIntervalHours: 24 },
        targets: [makeTarget('t1', { attemptN: 1, lastCheckedAt: T0, state: 'SATISFIED' })],
      });
      w.discoveryScript = [
        {
          candidates: [
            {
              connectionId: 'conn-new',
              label: 'acme/new',
              reachable: true,
              satisfied: false,
              teamId: 'team-a',
            },
          ],
          nextCursor: 25,
        },
        {
          candidates: [
            {
              connectionId: 'conn-other',
              label: 'other/repo',
              reachable: false,
              satisfied: false,
              teamId: 'team-b',
              unreachableReason: 'the launcher does not lead the team that owns the repository',
            },
          ],
          nextCursor: null,
        },
      ];
      w.onStart = finishesOnStart('NO_CHANGE');
      w.onRead = (_n, world) => {
        if (world.discoveryCalls.length >= 2) {
          world.campaign.hasScope = false;
        }
      };
      return w;
    },
  },
  {
    // The gateway refuses a start for the budget: the campaign is paused with that reason and
    // starts nothing; a person lifts the pause and the target runs to the end.
    drive: async (handle, w) => {
      await waitFor(() => w.campaign.state === 'PAUSED', 'the campaign to pause');
      w.refusals.clear();
      w.onStart = finishesOnStart('NO_CHANGE');
      w.campaign.state = 'ACTIVE';
      await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'resume' });
    },
    name: 'refusal-pause',
    world: () => {
      const w = makeWorld({ targets: [makeTarget('t1')] });
      w.refusals.set('t1', { code: 'BUDGET_EXCEEDED', message: 'The monthly budget is spent' });
      return w;
    },
  },
  {
    // A merged draft whose check still fails goes to NEEDS_ATTENTION and keeps the campaign
    // ACTIVE; a person skips it and the campaign completes.
    drive: async (handle, w) => {
      await waitFor(() => target(w, 't1').state === 'NEEDS_ATTENTION', 'the failed check');
      target(w, 't1').state = 'SKIPPED';
      await handle.signal(CAMPAIGN_CONTROL_SIGNAL, { action: 'removeTarget', targetId: 't1' });
    },
    name: 'check-failed',
    world: () => {
      const w = makeWorld({
        campaign: { hasCheck: true },
        targets: [
          makeTarget('t1', { attemptN: 1, prOpenedAt: T0, prStatus: 'MERGED', state: 'PR_OPENED' }),
        ],
      });
      w.checkAnswers.set('t1', ['not-satisfied']);
      return w;
    },
  },
];

const SCENARIO_TIMEOUT_MS = 120_000;

function withTimeout<T>(name: string, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`scenario '${name}' did not finish in ${SCENARIO_TIMEOUT_MS / 1000}s`)),
        SCENARIO_TIMEOUT_MS
      ).unref()
    ),
  ]);
}

async function record(scenario: Scenario, env: TestWorkflowEnvironment): Promise<number> {
  const world = scenario.world();
  const taskQueue = `replay-recorder-campaign-reconciler-${scenario.name}`;
  const workflowId = `replay-fixture-${scenario.name}`;
  const signaller = env.client.workflow.getHandle(workflowId);
  world.signal = (name, arg) => signaller.signal(name, arg);

  const activities = worldActivities(world);
  const worker = await Worker.create({
    activities: { ...activities },
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: WORKFLOWS_PATH,
  });
  const history = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start('CampaignReconcilerWorkflow', {
      args: [{ campaignId: CAMPAIGN_ID, campaignWorkflowId: workflowId }],
      taskQueue,
      workflowExecutionTimeout: '30 days',
      // The replay test replays each fixture under this same id.
      workflowId,
    });
    await scenario.drive?.(handle as unknown as Handle, world);
    await handle.result().catch(() => undefined);
    if (scenario.firstExecutionOnly) {
      return env.client.workflow
        .getHandle(handle.workflowId, handle.firstExecutionRunId)
        .fetchHistory();
    }
    return handle.fetchHistory();
  });

  const out = path.join(OUT_DIR, `${scenario.name}.bin`);
  writeFileSync(out, proto.temporal.api.history.v1.History.encode(history).finish());
  const last = history.events?.at(-1)?.eventType;
  console.log(
    `${scenario.name.padEnd(24)} ${String(history.events?.length ?? 0).padStart(5)} events, ends ${EventType[last as number]}`
  );
  return history.events?.length ?? 0;
}

async function main(): Promise<void> {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  mkdirSync(OUT_DIR, { recursive: true });
  const only = process.argv.slice(2);
  const unknown = only.filter((n) => !SCENARIOS.some((sc) => sc.name === n));
  if (unknown.length) {
    throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
  }
  const chosen = SCENARIOS.filter((sc) => only.length === 0 || only.includes(sc.name));
  // A fixture that exists is never rewritten by accident: it must be named.
  const existing = chosen.filter(
    (sc) => only.length === 0 && existsSync(path.join(OUT_DIR, `${sc.name}.bin`))
  );
  if (existing.length) {
    throw new Error(
      `fixture(s) already recorded: ${existing.map((s) => s.name).join(', ')}. Name a scenario to ` +
        'record it, and do so only when the reconciler changed intentionally.'
    );
  }
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    for (const scenario of chosen) {
      await withTimeout(scenario.name, record(scenario, env));
    }
  } finally {
    await env.teardown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
