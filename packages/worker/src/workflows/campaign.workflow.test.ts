/**
 * Workflow-level tests for the campaign workflow, run in Temporal's time-skipping test server.
 * The children are a stand-in `RunnableWorkflow` (see `testing/campaignWorkflows.ts`) scripted
 * per repository; the campaign activities are recording fakes.
 *
 * The suite skips itself when the test server cannot be started (no binary, no network).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAMPAIGN_CANCEL_SIGNAL,
  type CampaignWorkflowInput,
} from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import type { ChildScript } from './testing/campaignWorkflows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The campaign starts its children on this queue by name.
const TASK_QUEUE = 'engineering-workflow';
const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_WORKFLOW_ID = `campaign-${CAMPAIGN_ID}`;

interface Launch {
  payload: unknown;
  repoId: string;
  templateId: string;
  templateVersion: number;
  workflowId: string;
}

const scripts = new Map<string, ChildScript>();
const launches: Launch[] = [];
const started: Array<{
  campaignId: string;
  connectionId: string;
  childWorkflowId: string;
  teamId: string;
}> = [];
const results: Array<{
  cancelled: boolean;
  connectionId: string;
  status: string;
  skippedReason?: string;
}> = [];
const finalizations: Array<{
  cancelled: boolean;
  notStarted: string[];
  results: string[];
}> = [];
const campaignStates: string[] = [];
const domainStates: string[] = [];
const cancelledChildren: string[] = [];
let inFlight = 0;
let peak = 0;
let failRecordActivities = false;
let holdFanningOut = false;
/** The launch re-check: targets it refuses (with the reason), and the target that stops the rest. */
const refusedTargets = new Map<string, string>();
let stopAt: { connectionId: string; reason: string } | null = null;
let failAuthorize = false;
/** Transient re-check failures still to throw (retryable), before it answers. */
let authorizeFailuresLeft = 0;
let authorizeAttempts = 0;
/** The target whose re-check finds the campaign row cancelled (a cancel the signal never carried). */
let cancelledAt: string | null = null;
const authorizeCalls: string[][] = [];

const fakeActivities = {
  async authorizeCampaignTargets(input: { targets: Array<{ connectionId: string }> }) {
    authorizeAttempts += 1;
    if (authorizeFailuresLeft > 0) {
      authorizeFailuresLeft -= 1;
      throw ApplicationFailure.retryable('database unreachable for a moment');
    }
    authorizeCalls.push(input.targets.map((t) => t.connectionId));
    if (failAuthorize) {
      throw ApplicationFailure.nonRetryable('database unreachable');
    }
    if (cancelledAt && input.targets.some((t) => t.connectionId === cancelledAt)) {
      return { cancelled: true, stopReason: 'the campaign was cancelled', verdicts: [] };
    }
    if (stopAt && input.targets.some((t) => t.connectionId === stopAt?.connectionId)) {
      return { stopReason: stopAt.reason, verdicts: [] };
    }
    return {
      verdicts: input.targets.map((t) =>
        refusedTargets.has(t.connectionId)
          ? {
              allowed: false,
              connectionId: t.connectionId,
              reason: refusedTargets.get(t.connectionId),
            }
          : { allowed: true, connectionId: t.connectionId }
      ),
    };
  },
  async childBegan(): Promise<void> {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
  },
  async childCancelled(workflowId: string): Promise<void> {
    inFlight -= 1;
    cancelledChildren.push(workflowId);
  },
  async childEnded(): Promise<void> {
    inFlight -= 1;
  },
  async finalizeCampaign(input: {
    cancelled: boolean;
    notStarted: Array<{ connectionId: string }>;
    results: Array<{ connectionId: string; result: { status: string } }>;
  }) {
    finalizations.push({
      cancelled: input.cancelled,
      notStarted: input.notStarted.map((n) => n.connectionId),
      results: input.results.map((r) => r.connectionId),
    });
    if (input.cancelled) {
      return 'CANCELLED' as const;
    }
    return input.results.some((r) => r.result.status !== 'SUCCESS')
      ? ('COMPLETED_WITH_FAILURES' as const)
      : ('COMPLETED' as const);
  },
  async recordCampaignState(_id: string, state: string): Promise<void> {
    campaignStates.push(state);
  },
  async recordCampaignTargetResult(input: {
    cancelled: boolean;
    connectionId: string;
    result: { skippedReason?: string; status: string };
  }): Promise<void> {
    if (failRecordActivities) {
      throw ApplicationFailure.nonRetryable('record write failed');
    }
    results.push({
      cancelled: input.cancelled,
      connectionId: input.connectionId,
      ...(input.result.skippedReason ? { skippedReason: input.result.skippedReason } : {}),
      status: input.result.status,
    });
  },
  async recordCampaignTargetStarted(input: {
    campaignId: string;
    childWorkflowId: string;
    connectionId: string;
    teamId: string;
  }): Promise<void> {
    if (failRecordActivities) {
      throw ApplicationFailure.nonRetryable('record write failed');
    }
    started.push(input);
  },
  async scriptFor(input: Launch): Promise<ChildScript> {
    launches.push(input);
    return scripts.get(input.repoId) ?? { kind: 'park' };
  },
  async updateDomainState(_workflowId: string, status: string): Promise<void> {
    domainStates.push(status);
    if (holdFanningOut && status === 'FANNING_OUT') {
      await new Promise((r) => setTimeout(r, 3000));
    }
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
    workflowsPath: path.resolve(__dirname, './testing/campaignWorkflows.ts'),
  });
  workerRun = worker.run();
}, 240_000);

beforeEach((ctx: TestContext) => {
  if (!env || !worker) {
    ctx.skip();
  }
  scripts.clear();
  launches.length = 0;
  started.length = 0;
  results.length = 0;
  finalizations.length = 0;
  campaignStates.length = 0;
  domainStates.length = 0;
  cancelledChildren.length = 0;
  inFlight = 0;
  peak = 0;
  failRecordActivities = false;
  holdFanningOut = false;
  refusedTargets.clear();
  stopAt = null;
  failAuthorize = false;
  authorizeFailuresLeft = 0;
  authorizeAttempts = 0;
  cancelledAt = null;
  authorizeCalls.length = 0;
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

const repoIds = (n: number) => Array.from({ length: n }, (_, i) => `repo-${i + 1}`);

function campaignInput(
  ids: string[],
  overrides: Partial<CampaignWorkflowInput> = {}
): CampaignWorkflowInput {
  return {
    campaignId: CAMPAIGN_ID,
    campaignWorkflowId: CAMPAIGN_WORKFLOW_ID,
    childPayload: {
      budget: 'STANDARD',
      packageName: 'left-pad',
      recipe: 'npm-dependency@1',
      targetVersion: '1.3.0',
    },
    description: 'Upgrade left-pad',
    externalTicketId: 'CAMPAIGN-111111111111',
    launchedById: 'user-lead',
    maxParallel: 2,
    targets: ids.map((id) => ({ connectionId: id, repoLabel: `acme/${id}`, teamId: 'team-a' })),
    templateId: 'tpl-upgrade',
    templateVersion: 7,
    workRequestId: '00000000-0000-4000-8000-000000000009',
    ...overrides,
  };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!cond()) {
    throw new Error(`timed out waiting for ${what}`);
  }
}

describe('CampaignWorkflow — throttled fan-out', () => {
  it('never has more than maxParallel children in flight, and starts them in input order', async () => {
    if (!env) {
      return;
    }
    const ids = repoIds(5);
    for (const id of ids) {
      scripts.set(id, { delayMs: 60_000, kind: 'result', result: { changed: false } });
    }
    const result = await env.client.workflow.execute('CampaignWorkflow', {
      args: [campaignInput(ids)],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });

    expect(peak).toBe(2);
    expect(result.status).toBe('COMPLETED');
    expect(Object.keys(result.childResults).sort()).toEqual(ids);
    // Input order, with the deterministic ids, the pinned template and the merged payload.
    // The workflow's own command order, from its history: the activities that report a launch
    // run concurrently on the worker, so their arrival order proves nothing.
    const history = await env.client.workflow.getHandle(CAMPAIGN_WORKFLOW_ID).fetchHistory();
    const startedIds = (history.events ?? [])
      .map((e) => e.startChildWorkflowExecutionInitiatedEventAttributes?.workflowId)
      .filter(Boolean);
    expect(startedIds).toEqual(ids.map((id) => `${CAMPAIGN_WORKFLOW_ID}-${id}`));
    expect(launches.map((l) => l.repoId).sort()).toEqual(ids);
    expect(launches).toHaveLength(ids.length);
    for (const launch of launches) {
      expect(launch.workflowId).toBe(`${CAMPAIGN_WORKFLOW_ID}-${launch.repoId}`);
      expect(launch.templateId).toBe('tpl-upgrade');
      expect(launch.templateVersion).toBe(7);
      expect(launch.payload).toEqual({
        budget: 'STANDARD',
        connectionId: launch.repoId,
        packageName: 'left-pad',
        recipe: 'npm-dependency@1',
        targetVersion: '1.3.0',
      });
    }
    expect(started.map((s) => s.connectionId).sort()).toEqual(ids);
    expect(started.find((s) => s.connectionId === 'repo-1')).toEqual({
      campaignId: CAMPAIGN_ID,
      childWorkflowId: `${CAMPAIGN_WORKFLOW_ID}-repo-1`,
      connectionId: 'repo-1',
      teamId: 'team-a',
    });
    expect(campaignStates).toEqual(['RUNNING']);
    expect(domainStates).toEqual(['FANNING_OUT', 'COMPLETED']);
  }, 60_000);

  it('records mixed outcomes per target and finishes COMPLETED_WITH_FAILURES', async () => {
    if (!env) {
      return;
    }
    const ids = repoIds(4);
    scripts.set('repo-1', {
      kind: 'result',
      result: { changed: true, prNumber: 4, prUrl: 'https://github.com/acme/repo-1/pull/4' },
    });
    scripts.set('repo-2', { kind: 'result', result: { changed: false } });
    scripts.set('repo-3', {
      kind: 'result',
      result: { skippedReason: 'verification failed', status: 'FAILED' },
    });
    // A child that rejects (a non-retryable activity failure) must not stop the scheduler.
    scripts.set('repo-4', { kind: 'reject' });

    const result = await env.client.workflow.execute('CampaignWorkflow', {
      args: [campaignInput(ids, { maxParallel: 3 })],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });

    expect(result.status).toBe('COMPLETED_WITH_FAILURES');
    expect(results.map((r) => [r.connectionId, r.status, r.cancelled]).sort()).toEqual([
      ['repo-1', 'SUCCESS', false],
      ['repo-2', 'SUCCESS', false],
      ['repo-3', 'FAILED', false],
      ['repo-4', 'FAILED', false],
    ]);
    const rejected = results.find((r) => r.connectionId === 'repo-4');
    expect(rejected?.skippedReason).toMatch(/^child failed to start or errored/);
    expect(rejected?.skippedReason).toContain('PROTECTED_TESTS_UNAVAILABLE');
    expect(finalizations).toHaveLength(1);
    expect(finalizations[0].cancelled).toBe(false);
    expect(finalizations[0].notStarted).toEqual([]);
    expect([...finalizations[0].results].sort()).toEqual(ids);
    expect(domainStates.at(-1)).toBe('FAILED');
  }, 60_000);

  it('keeps going when the record activities keep failing', async () => {
    if (!env) {
      return;
    }
    failRecordActivities = true;
    const ids = repoIds(3);
    for (const id of ids) {
      scripts.set(id, { kind: 'result', result: { changed: false } });
    }
    const result = await env.client.workflow.execute('CampaignWorkflow', {
      args: [campaignInput(ids, { maxParallel: 1 })],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });

    expect(result.status).toBe('COMPLETED');
    expect(launches.map((l) => l.repoId)).toEqual(ids); // maxParallel 1: strictly sequential
    expect(results).toEqual([]);
    // Finalize still receives every result, so it can reconcile the rows the records missed.
    expect(finalizations[0].results).toEqual(ids);
  }, 60_000);
});

describe('CampaignWorkflow — the launch re-checked before each start', () => {
  it('re-checks every target before its child starts, in input order', async () => {
    if (!env) {
      return;
    }
    const ids = repoIds(3);
    for (const id of ids) {
      scripts.set(id, { kind: 'result', result: { changed: false } });
    }
    await env.client.workflow.execute('CampaignWorkflow', {
      args: [campaignInput(ids, { maxParallel: 2 })],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });
    // The first batch fills both slots; each later start is checked as its slot frees.
    expect(authorizeCalls).toEqual([['repo-1', 'repo-2'], ['repo-3']]);
    const history = await env.client.workflow.getHandle(CAMPAIGN_WORKFLOW_ID).fetchHistory();
    // One scheduling path: no patch marker.
    const markers = (history.events ?? []).filter((e) => e.markerRecordedEventAttributes);
    expect(markers).toHaveLength(0);
  }, 60_000);

  it('never starts a refused target: it ends SKIPPED with the reason, and the rest go on', async () => {
    if (!env) {
      return;
    }
    const ids = repoIds(4);
    for (const id of ids) {
      scripts.set(id, { kind: 'result', result: { changed: false } });
    }
    refusedTargets.set('repo-2', 'the repository is no longer an active git repository');
    const result = await env.client.workflow.execute('CampaignWorkflow', {
      args: [campaignInput(ids, { maxParallel: 2 })],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });

    expect(result.status).toBe('COMPLETED_WITH_FAILURES');
    expect(launches.map((l) => l.repoId).sort()).toEqual(['repo-1', 'repo-3', 'repo-4']);
    const refused = results.find((r) => r.connectionId === 'repo-2');
    expect(refused).toMatchObject({ cancelled: false, status: 'SKIPPED' });
    expect(refused?.skippedReason).toBe(
      'not started: the repository is no longer an active git repository'
    );
    expect(result.childResults['repo-2']?.status).toBe('SKIPPED');
    expect(finalizations[0].notStarted).toEqual([]);
  }, 60_000);

  it('stops every target still queued when the campaign-wide re-check refuses', async () => {
    if (!env) {
      return;
    }
    const ids = repoIds(4);
    for (const id of ids) {
      scripts.set(id, { kind: 'result', result: { changed: false } });
    }
    // The owning team's kill switch is turned off by the time repo-3's slot frees.
    stopAt = {
      connectionId: 'repo-3',
      reason: 'workflow.campaignsEnabled was turned off for the owning team',
    };
    const result = await env.client.workflow.execute('CampaignWorkflow', {
      args: [campaignInput(ids, { maxParallel: 2 })],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });

    expect(launches.map((l) => l.repoId).sort()).toEqual(['repo-1', 'repo-2']);
    for (const id of ['repo-3', 'repo-4']) {
      const r = results.find((x) => x.connectionId === id);
      expect(r).toMatchObject({ status: 'SKIPPED' });
      expect(r?.skippedReason).toMatch(/campaignsEnabled was turned off for the owning team/);
    }
    expect(result.status).toBe('COMPLETED_WITH_FAILURES');
    expect(finalizations[0].notStarted).toEqual([]);
  }, 60_000);

  it('stops as a cancel when the re-check finds the campaign row cancelled', async () => {
    if (!env) {
      return;
    }
    const ids = repoIds(4);
    // repo-1 finishes; repo-2 parks. The campaign was cancelled in the database without a signal
    // reaching this execution, so the re-check for repo-3's slot finds it cancelled.
    scripts.set('repo-1', { delayMs: 1000, kind: 'result', result: { changed: false } });
    scripts.set('repo-2', { kind: 'park' });
    cancelledAt = 'repo-3';
    const result = await env.client.workflow.execute('CampaignWorkflow', {
      args: [campaignInput(ids, { maxParallel: 2 })],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });

    expect(result.status).toBe('CANCELLED');
    expect(launches.map((l) => l.repoId).sort()).toEqual(['repo-1', 'repo-2']);
    // The child in flight is cancelled with the campaign, as the signal would cancel it.
    expect(cancelledChildren).toEqual([`${CAMPAIGN_WORKFLOW_ID}-repo-2`]);
    expect(finalizations).toHaveLength(1);
    expect(finalizations[0].cancelled).toBe(true);
    expect(finalizations[0].notStarted).toEqual(['repo-3', 'repo-4']);
    expect(results.find((r) => r.connectionId === 'repo-2')).toMatchObject({ cancelled: true });
    expect(domainStates.at(-1)).toBe('CANCELLED');
  }, 60_000);

  it('retries a re-check that fails for minutes before failing closed', async () => {
    if (!env) {
      return;
    }
    // More failures than the five attempts the state writes get (RETRY_STATE), well inside the
    // re-check's own policy: the campaign waits the blip out and starts its children.
    authorizeFailuresLeft = 8;
    const ids = repoIds(2);
    for (const id of ids) {
      scripts.set(id, { kind: 'result', result: { changed: false } });
    }
    const result = await env.client.workflow.execute('CampaignWorkflow', {
      args: [campaignInput(ids, { maxParallel: 2 })],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });

    expect(authorizeAttempts).toBe(9);
    expect(result.status).toBe('COMPLETED');
    expect(launches.map((l) => l.repoId).sort()).toEqual(ids);
    expect(results.every((r) => r.status === 'SUCCESS')).toBe(true);
  }, 60_000);

  it('fails closed when the re-check cannot be made: nothing starts unchecked', async () => {
    if (!env) {
      return;
    }
    failAuthorize = true;
    const ids = repoIds(3);
    const result = await env.client.workflow.execute('CampaignWorkflow', {
      args: [campaignInput(ids, { maxParallel: 2 })],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });

    expect(launches).toEqual([]);
    expect(results.map((r) => [r.connectionId, r.status])).toEqual([
      ['repo-1', 'SKIPPED'],
      ['repo-2', 'SKIPPED'],
      ['repo-3', 'SKIPPED'],
    ]);
    expect(results[0]?.skippedReason).toMatch(/could not be re-checked: .*database unreachable/);
    expect(result.status).toBe('COMPLETED_WITH_FAILURES');
  }, 60_000);
});

describe('CampaignWorkflow — cancel', () => {
  async function startParked(): Promise<{
    handle: Awaited<ReturnType<NonNullable<typeof env>['client']['workflow']['start']>>;
    ids: string[];
  }> {
    const ids = repoIds(4);
    // repo-1 finishes quickly with a PR; repo-2 and repo-3 park; repo-4 stays queued.
    scripts.set('repo-1', {
      delayMs: 1000,
      kind: 'result',
      result: { changed: true, prNumber: 1, prUrl: 'https://github.com/acme/repo-1/pull/1' },
    });
    scripts.set('repo-2', { kind: 'park' });
    scripts.set('repo-3', { kind: 'park' });
    scripts.set('repo-4', { kind: 'park' });
    const handle = await env?.client.workflow.start('CampaignWorkflow', {
      args: [campaignInput(ids, { maxParallel: 2 })],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });
    if (!handle) {
      throw new Error('no environment');
    }
    // repo-1 ends, repo-3 takes its slot, so repo-2 and repo-3 are parked and repo-4 is queued.
    await waitFor(() => launches.length === 3 && inFlight === 2, 'two parked children');
    return { handle, ids };
  }

  it('campaignCancelSignal cancels in-flight children and reports the queue as not started', async () => {
    if (!env) {
      return;
    }
    const { handle } = await startParked();
    await handle.signal(CAMPAIGN_CANCEL_SIGNAL);
    const result = await handle.result();

    expect(result.status).toBe('CANCELLED');
    expect([...cancelledChildren].sort()).toEqual([
      `${CAMPAIGN_WORKFLOW_ID}-repo-2`,
      `${CAMPAIGN_WORKFLOW_ID}-repo-3`,
    ]);
    // repo-4 never started.
    expect(launches.map((l) => l.repoId)).not.toContain('repo-4');
    expect(finalizations).toHaveLength(1);
    expect(finalizations[0].cancelled).toBe(true);
    expect(finalizations[0].notStarted).toEqual(['repo-4']);
    // The child that finished before the cancel keeps its SUCCESS verdict; the parked ones were
    // recorded as cancelled results.
    const byRepo = Object.fromEntries(finalizations[0].results.map((id) => [id, true]));
    expect(Object.keys(byRepo).sort()).toEqual(['repo-1', 'repo-2', 'repo-3']);
    expect(result.childResults['repo-1']?.status).toBe('SUCCESS');
    expect(
      results
        .filter((r) => r.cancelled)
        .map((r) => r.connectionId)
        .sort()
    ).toEqual(['repo-2', 'repo-3']);
    expect(domainStates.at(-1)).toBe('CANCELLED');
    for (const id of ['repo-2', 'repo-3']) {
      const d = await env.client.workflow.getHandle(`${CAMPAIGN_WORKFLOW_ID}-${id}`).describe();
      expect(d.status.name).toBe('CANCELLED');
    }
  }, 60_000);

  it('a child cancelled on its own fails that target and does not cancel the campaign', async () => {
    if (!env) {
      return;
    }
    const ids = repoIds(4);
    // repo-1 parks (the default); the others finish, so the rest of the queue must still start.
    for (const id of ['repo-2', 'repo-3', 'repo-4']) {
      scripts.set(id, { delayMs: 60_000, kind: 'result', result: { changed: false } });
    }
    const handle = await env.client.workflow.start('CampaignWorkflow', {
      args: [campaignInput(ids, { maxParallel: 2 })],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });
    await waitFor(() => launches.length === 2 && inFlight === 2, 'two children in flight');
    // A per-run cancel of one child, as the run's own cancel route or the Temporal UI sends it.
    await env.client.workflow.getHandle(`${CAMPAIGN_WORKFLOW_ID}-repo-1`).cancel();
    const result = await handle.result();

    expect(result.status).toBe('COMPLETED_WITH_FAILURES');
    expect(launches.map((l) => l.repoId).sort()).toEqual(ids);
    expect(finalizations).toHaveLength(1);
    expect(finalizations[0].cancelled).toBe(false);
    expect(finalizations[0].notStarted).toEqual([]);
    const cancelledOne = results.find((r) => r.connectionId === 'repo-1');
    expect(cancelledOne).toMatchObject({ cancelled: false, status: 'FAILED' });
    expect(cancelledOne?.skippedReason).toMatch(/cancelled outside the campaign/);
    expect(results.filter((r) => r.cancelled)).toEqual([]);
    expect(domainStates.at(-1)).toBe('FAILED');
  }, 60_000);

  it('a cancel during the first ledger write still finalizes every target as not started', async () => {
    if (!env) {
      return;
    }
    holdFanningOut = true;
    const ids = repoIds(3);
    const handle = await env.client.workflow.start('CampaignWorkflow', {
      args: [campaignInput(ids)],
      taskQueue: TASK_QUEUE,
      workflowId: CAMPAIGN_WORKFLOW_ID,
    });
    await waitFor(() => domainStates.includes('FANNING_OUT'), 'the first ledger write');
    await handle.cancel();
    await handle.result().catch(() => undefined);

    await waitFor(() => finalizations.length === 1, 'finalization');
    expect(launches).toEqual([]);
    expect(finalizations[0].cancelled).toBe(true);
    expect(finalizations[0].notStarted).toEqual(ids);
    expect(finalizations[0].results).toEqual([]);
    expect(domainStates.at(-1)).toBe('CANCELLED');
  }, 60_000);

  it('cancelling the campaign workflow itself behaves the same and still finalizes', async () => {
    if (!env) {
      return;
    }
    const { handle } = await startParked();
    await handle.cancel();
    await handle.result().catch(() => undefined);

    // Finalization ran in the non-cancellable scope even though the workflow was cancelled.
    await waitFor(() => finalizations.length === 1, 'finalization');
    expect(finalizations[0].cancelled).toBe(true);
    expect(finalizations[0].notStarted).toEqual(['repo-4']);
    expect([...cancelledChildren].sort()).toEqual([
      `${CAMPAIGN_WORKFLOW_ID}-repo-2`,
      `${CAMPAIGN_WORKFLOW_ID}-repo-3`,
    ]);
    expect(domainStates.at(-1)).toBe('CANCELLED');
  }, 60_000);
});
