/**
 * A fake world for `CampaignReconcilerWorkflow`: an in-memory campaign and the activities that
 * read and write it with the same conditional semantics as the real ones
 * (`activities/campaignReconciler.ts`), so a workflow test (and the replay recorder) drives the real
 * workflow code against rows it can inspect and mutate between passes.
 *
 * Test-only. Nothing here runs in production.
 */
import {
  isTargetFinal,
  normalizeTargetState,
  type ReconcilerTargetState,
  type TargetState,
  transitionTarget,
} from '@auto-swe/shared/lib/campaignState';
import type {
  CampaignPassSnapshot,
  DiscoveredCandidate,
  PassCampaign,
  PassTarget,
  RecordCampaignPassInput,
  RecordCampaignPassResult,
  RunCampaignCheckResult,
  StartCampaignAttemptResult,
} from '../../lib/campaignReconcilerTypes.js';

export type CheckAnswer = 'satisfied' | 'not-satisfied' | 'could-not-run';

export interface World {
  /** The database clock, epoch ms; advanced by `tick` on every read. */
  now: number;
  tick: number;
  campaign: PassCampaign;
  planned: boolean;
  targets: PassTarget[];
  proposalConnectionIds: string[];
  pausedReason: string | null;

  // Scripting
  /** Runs at the start of read number `n` (1-based), before the snapshot is taken. */
  onRead?: (n: number, world: World) => void;
  /** Runs when a start succeeded, with the target as it now stands. */
  onStart?: (target: PassTarget, world: World) => void | Promise<void>;
  /** Signals the workflow under test; set by the harness that started it. */
  signal?: (name: string, arg?: unknown) => Promise<void>;
  /** Answers of the next checks, per target; `satisfied` once a queue is empty. */
  checkAnswers: Map<string, CheckAnswer[]>;
  /** Refusals the gateway answers a start with, per target. */
  refusals: Map<string, { code: string; message: string }>;
  discovery: DiscoveredCandidate[];
  failPlan: boolean;

  // What happened
  reads: number;
  starts: Array<{ targetId: string; attemptN: number }>;
  records: RecordCampaignPassInput[];
  checks: string[];
  discoveries: number;
  plans: number;
  cancelledAttempts: number;
  finalized: Array<'COMPLETED' | 'CANCELLED'>;
  domainStates: string[];
}

export const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);

export function makeCampaign(over: Partial<PassCampaign> = {}): PassCampaign {
  return {
    budgetExceeded: false,
    campaignsEnabled: true,
    expiresAt: null,
    gate: 'OPENED',
    hasCheck: false,
    hasScope: false,
    launcherAvailable: true,
    maxOpenPullRequests: null,
    maxParallel: 2,
    maxTargets: 200,
    plan: 'UNIFORM',
    rescanIntervalHours: 24,
    staleAfterDays: null,
    state: 'ACTIVE',
    ...over,
  };
}

export function makeTarget(id: string, over: Partial<PassTarget> = {}): PassTarget {
  return {
    attemptFailureReason: null,
    attemptN: 0,
    attemptOutcome: null,
    connectionId: `conn-${id}`,
    dependsOn: [],
    failureReason: null,
    id,
    label: `acme/${id}`,
    lastCheckedAt: null,
    position: Number(id.replace(/\D/g, '')) || 0,
    prOpenedAt: null,
    prStatus: null,
    regressions: 0,
    staleSince: null,
    state: 'PENDING',
    teamId: 'team-a',
    ...over,
  };
}

export function makeWorld(
  over: { campaign?: Partial<PassCampaign>; targets?: PassTarget[]; tick?: number } = {}
): World {
  return {
    campaign: makeCampaign(over.campaign),
    cancelledAttempts: 0,
    checkAnswers: new Map(),
    checks: [],
    discoveries: 0,
    discovery: [],
    domainStates: [],
    failPlan: false,
    finalized: [],
    now: T0,
    pausedReason: null,
    planned: false,
    plans: 0,
    proposalConnectionIds: [],
    reads: 0,
    records: [],
    refusals: new Map(),
    starts: [],
    targets: over.targets ?? [],
    tick: over.tick ?? 60_000,
  };
}

export const target = (world: World, id: string): PassTarget => {
  const t = world.targets.find((x) => x.id === id);
  if (!t) {
    throw new Error(`no target ${id}`);
  }
  return t;
};

/** The state of every target, by id. */
export const states = (world: World): Record<string, ReconcilerTargetState> =>
  Object.fromEntries(world.targets.map((t) => [t.id, normalizeTargetState(t.state)]));

/** What a run's finalization does to the rows: the latest attempt ends with `outcome`. */
export function finishAttempt(
  world: World,
  id: string,
  outcome: 'PR_OPENED' | 'NO_CHANGE' | 'FAILED' | 'CANCELLED',
  extra: { failureReason?: string; prOpenedAt?: number } = {}
): void {
  const t = target(world, id);
  t.attemptOutcome = outcome;
  t.attemptFailureReason = extra.failureReason ?? null;
  if (outcome === 'PR_OPENED') {
    t.prStatus = 'OPEN';
    t.prOpenedAt = extra.prOpenedAt ?? world.now;
  }
}

export function setPullRequest(world: World, id: string, status: 'OPEN' | 'MERGED' | 'CLOSED') {
  target(world, id).prStatus = status;
}

/** The activities, over `world`. Register them on a test worker as they are. */
export function worldActivities(world: World) {
  return {
    async cancelCampaignAttempts(): Promise<{ cancelled: number }> {
      world.cancelledAttempts += 1;
      return {
        cancelled: world.targets.filter((t) => normalizeTargetState(t.state) === 'RUNNING').length,
      };
    },

    async discoverCampaignTargets(): Promise<{
      candidates: DiscoveredCandidate[];
      nextCursor: number | null;
    }> {
      world.discoveries += 1;
      return { candidates: world.discovery, nextCursor: null };
    },

    async finalizeCampaignReconciler(input: { outcome: 'COMPLETED' | 'CANCELLED' }): Promise<void> {
      world.finalized.push(input.outcome);
      if (input.outcome === 'CANCELLED') {
        world.campaign.state = 'CANCELLED';
        for (const t of world.targets) {
          if (['PENDING', 'BLOCKED', 'RUNNING', 'NEEDS_ATTENTION'].includes(t.state)) {
            t.state = 'CANCELLED';
          }
        }
      }
    },

    async planCampaignBriefs(): Promise<{ planned: number; edges: number }> {
      world.plans += 1;
      if (world.failPlan) {
        throw new Error('the planner is unavailable');
      }
      world.planned = true;
      return { edges: 0, planned: world.targets.length };
    },

    async readCampaignPass(): Promise<CampaignPassSnapshot | null> {
      world.reads += 1;
      world.onRead?.(world.reads, world);
      world.now += world.tick;
      return structuredClone({
        campaign: world.campaign,
        nowMs: world.now,
        planned: world.planned,
        proposalConnectionIds: world.proposalConnectionIds,
        targets: world.targets,
      });
    },

    async recordCampaignPass(input: RecordCampaignPassInput): Promise<RecordCampaignPassResult> {
      world.records.push(structuredClone(input));
      let skipped = 0;
      for (const u of input.updates) {
        const t = world.targets.find((x) => x.id === u.targetId);
        if (!t || isTargetFinal(u.expect) || t.state !== u.expect) {
          skipped += 1;
          continue;
        }
        t.state = u.state;
        if (u.regressions !== undefined) {
          t.regressions = u.regressions;
        }
        if (u.failureReason !== undefined) {
          t.failureReason = u.failureReason;
        }
        if (u.staleSince !== undefined) {
          t.staleSince = u.staleSince;
        }
      }
      const added: RecordCampaignPassResult['added'] = [];
      for (const a of input.addTargets) {
        if (world.targets.some((t) => t.connectionId === a.connectionId)) {
          continue;
        }
        const position = Math.max(-1, ...world.targets.map((t) => t.position)) + 1;
        const id = `new-${position}`;
        world.targets.push(
          makeTarget(id, {
            connectionId: a.connectionId,
            label: a.label,
            position,
            teamId: a.teamId,
          })
        );
        added.push({
          connectionId: a.connectionId,
          label: a.label,
          position,
          targetId: id,
          teamId: a.teamId,
        });
      }
      for (const p of input.proposals) {
        world.proposalConnectionIds.push(p.connectionId);
      }
      let campaignChanged = false;
      if (input.campaign && world.campaign.state === input.campaign.from) {
        world.campaign.state = input.campaign.to;
        world.pausedReason =
          input.campaign.to === 'PAUSED' ? (input.campaign.pausedReason ?? null) : null;
        campaignChanged = true;
      }
      return { added, campaignChanged, skipped };
    },

    async runCampaignCheck(input: { targetId: string }): Promise<RunCampaignCheckResult> {
      world.checks.push(input.targetId);
      const t = target(world, input.targetId);
      const queue = world.checkAnswers.get(input.targetId) ?? [];
      const answer: CheckAnswer = queue.shift() ?? 'satisfied';
      t.lastCheckedAt = world.now;
      if (answer === 'could-not-run') {
        return {
          changed: false,
          lastCheckedAt: world.now,
          reason: 'the check could not run',
          regressions: t.regressions,
          state: normalizeTargetState(t.state),
          status: 'could-not-run',
          targetId: input.targetId,
        };
      }
      const next = transitionTarget(
        { regressions: t.regressions, state: t.state },
        { satisfied: answer === 'satisfied', type: 'check' }
      );
      const moves = next.accepted && next.state !== normalizeTargetState(t.state);
      if (moves) {
        t.state = next.state;
        t.regressions = next.regressions;
        t.failureReason = next.state === 'NEEDS_ATTENTION' ? 'the check failed' : null;
      }
      return {
        changed: moves,
        ...(moves ? { failureReason: t.failureReason } : {}),
        lastCheckedAt: world.now,
        regressions: t.regressions,
        state: normalizeTargetState(t.state),
        status: answer,
        targetId: input.targetId,
      };
    },

    async startCampaignAttempt(input: {
      targetId: string;
      attemptN: number;
    }): Promise<StartCampaignAttemptResult> {
      const refusal = world.refusals.get(input.targetId);
      if (refusal) {
        return { ...refusal, ok: false };
      }
      const t = target(world, input.targetId);
      const state: TargetState = t.state;
      if (state !== 'PENDING' && state !== 'BLOCKED') {
        return { code: 'TARGET_NOT_STARTABLE', message: `the target is ${state}`, ok: false };
      }
      t.state = 'RUNNING';
      t.attemptN = input.attemptN;
      t.attemptOutcome = null;
      t.attemptFailureReason = null;
      t.failureReason = null;
      world.starts.push({ attemptN: input.attemptN, targetId: input.targetId });
      await world.onStart?.(t, world);
      return {
        attemptId: `attempt-${input.targetId}-${input.attemptN}`,
        n: input.attemptN,
        ok: true,
        runId: null,
        workflowId: `campaign-test-${input.targetId}-${input.attemptN}`,
      };
    },

    async updateDomainState(_workflowId: string, status: string): Promise<void> {
      world.domainStates.push(status);
    },
  };
}
