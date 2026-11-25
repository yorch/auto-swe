import { describe, expect, it } from 'vitest';
import {
  type BlockReason,
  CAMPAIGN_STATE_VALUES,
  CAMPAIGN_TARGET_STATE_VALUES,
  type CampaignGateValue,
  type CampaignStateValue,
  computeTransitiveDependents,
  countTargets,
  decideCampaignState,
  decidePause,
  decideSchedule,
  decideStaleSince,
  describeBlockReason,
  diffDiscovery,
  isDue,
  isTargetFinal,
  isTargetFinalFor,
  nextDueAt,
  normalizeTargetState,
  type ScheduleInput,
  type ScheduleTarget,
  type TargetEvent,
  type TargetState,
  transitionTarget,
} from './campaignState.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

function step(state: TargetState, event: TargetEvent, regressions = 0, regressionLimit?: number) {
  return transitionTarget({ regressions, state }, event, { regressionLimit });
}

describe('normalizeTargetState / isTargetFinal', () => {
  it('folds the retired states into their replacements', () => {
    expect(normalizeTargetState('NOT_AFFECTED')).toBe('SATISFIED');
    expect(normalizeTargetState('FAILED')).toBe('NEEDS_ATTENTION');
    expect(normalizeTargetState('PR_OPENED')).toBe('PR_OPENED');
  });

  it('marks exactly SATISFIED, SKIPPED and CANCELLED final (PR_OPENED no longer is)', () => {
    const final = CAMPAIGN_TARGET_STATE_VALUES.filter(isTargetFinal).sort();
    expect(final).toEqual(['CANCELLED', 'NOT_AFFECTED', 'SATISFIED', 'SKIPPED']);
    expect(isTargetFinal('PR_OPENED')).toBe(false);
    expect(isTargetFinal('NEEDS_ATTENTION')).toBe(false);
    expect(isTargetFinal('FAILED')).toBe(false);
  });
});

describe('transitionTarget', () => {
  it('walks the happy path from PENDING to SATISFIED through a merge', () => {
    let r = step('PENDING', { type: 'attemptStarted' });
    expect(r).toMatchObject({ accepted: true, changed: true, state: 'RUNNING' });
    r = step(r.state, { outcome: 'PR_OPENED', type: 'attemptFinished' });
    expect(r.state).toBe('PR_OPENED');
    r = step(r.state, { status: 'OPEN', type: 'pullRequest' });
    expect(r).toMatchObject({ accepted: true, changed: false, state: 'PR_OPENED' });
    r = step(r.state, { status: 'MERGED', type: 'pullRequest' });
    expect(r.state).toBe('MERGED');
    r = step(r.state, { satisfied: true, type: 'check' });
    expect(r.state).toBe('SATISFIED');
  });

  it('maps every attempt outcome from RUNNING', () => {
    const outcome = (o: 'PR_OPENED' | 'NO_CHANGE' | 'FAILED' | 'CANCELLED') =>
      step('RUNNING', { outcome: o, type: 'attemptFinished' }).state;
    expect(outcome('PR_OPENED')).toBe('PR_OPENED');
    expect(outcome('NO_CHANGE')).toBe('SATISFIED');
    expect(outcome('FAILED')).toBe('NEEDS_ATTENTION');
    expect(outcome('CANCELLED')).toBe('CANCELLED');
  });

  it('sends a closed-unmerged pull request to NEEDS_ATTENTION', () => {
    expect(step('PR_OPENED', { status: 'CLOSED', type: 'pullRequest' }).state).toBe(
      'NEEDS_ATTENTION'
    );
  });

  it('sends a merge that did not satisfy the check to NEEDS_ATTENTION', () => {
    expect(step('MERGED', { satisfied: false, type: 'check' }).state).toBe('NEEDS_ATTENTION');
  });

  it('leaves a target where it is when the check could not run', () => {
    for (const state of [
      'PENDING',
      'BLOCKED',
      'PR_OPENED',
      'MERGED',
      'SATISFIED',
      'NEEDS_ATTENTION',
    ] as const) {
      const r = step(state, { couldNotRun: true, satisfied: false, type: 'check' });
      expect(r).toMatchObject({ accepted: true, changed: false, regressions: 0, state });
    }
    // An unanswered check never finishes a target, whatever `satisfied` says.
    expect(step('MERGED', { couldNotRun: true, satisfied: true, type: 'check' }).state).toBe(
      'MERGED'
    );
  });

  it('finishes a target a person fixed by hand', () => {
    for (const state of ['PENDING', 'BLOCKED', 'PR_OPENED', 'NEEDS_ATTENTION'] as const) {
      expect(step(state, { satisfied: true, type: 'check' }).state).toBe('SATISFIED');
    }
    expect(step('RUNNING', { satisfied: true, type: 'check' })).toMatchObject({
      accepted: false,
      state: 'RUNNING',
    });
  });

  describe('regression', () => {
    it('returns a SATISFIED target to PENDING with regressions + 1', () => {
      const r = step('SATISFIED', { satisfied: false, type: 'check' }, 0);
      expect(r).toMatchObject({ changed: true, regressions: 1, state: 'PENDING' });
    });

    it('keeps the target satisfied when the check passes', () => {
      expect(step('SATISFIED', { satisfied: true, type: 'check' }, 2)).toMatchObject({
        changed: false,
        regressions: 2,
        state: 'SATISFIED',
      });
    });

    it('needs a person once regressions pass the limit', () => {
      expect(step('SATISFIED', { satisfied: false, type: 'check' }, 2, 3).state).toBe('PENDING');
      expect(step('SATISFIED', { satisfied: false, type: 'check' }, 3, 3)).toMatchObject({
        regressions: 4,
        state: 'NEEDS_ATTENTION',
      });
    });

    it('defaults the limit to 3', () => {
      expect(step('SATISFIED', { satisfied: false, type: 'check' }, 3).state).toBe(
        'NEEDS_ATTENTION'
      );
      expect(step('SATISFIED', { satisfied: false, type: 'check' }, 2).state).toBe('PENDING');
    });
  });

  it('blocks and unblocks', () => {
    expect(step('PENDING', { type: 'block' }).state).toBe('BLOCKED');
    expect(step('BLOCKED', { type: 'unblock' }).state).toBe('PENDING');
    expect(step('BLOCKED', { type: 'block' })).toMatchObject({ accepted: true, changed: false });
    expect(step('BLOCKED', { type: 'attemptStarted' }).state).toBe('RUNNING');
    expect(step('PENDING', { type: 'unblock' }).accepted).toBe(false);
  });

  it('retries only a NEEDS_ATTENTION target', () => {
    expect(step('NEEDS_ATTENTION', { type: 'retry' }).state).toBe('PENDING');
    for (const state of [
      'PENDING',
      'RUNNING',
      'PR_OPENED',
      'MERGED',
      'SATISFIED',
      'SKIPPED',
    ] as const) {
      expect(step(state, { type: 'retry' })).toMatchObject({ accepted: false, state });
    }
  });

  it('removes any unfinished target but not one in flight', () => {
    for (const state of [
      'PENDING',
      'BLOCKED',
      'PR_OPENED',
      'MERGED',
      'SATISFIED',
      'NEEDS_ATTENTION',
    ] as const) {
      expect(step(state, { type: 'remove' }).state).toBe('SKIPPED');
    }
    expect(step('RUNNING', { type: 'remove' })).toMatchObject({
      accepted: false,
      state: 'RUNNING',
    });
  });

  it('cancels what has not delivered and keeps drafts and finished targets', () => {
    for (const state of ['PENDING', 'BLOCKED', 'RUNNING', 'NEEDS_ATTENTION'] as const) {
      expect(step(state, { type: 'cancel' }).state).toBe('CANCELLED');
    }
    for (const state of ['PR_OPENED', 'MERGED', 'SATISFIED'] as const) {
      expect(step(state, { type: 'cancel' })).toMatchObject({ changed: false, state });
    }
  });

  it('follows a pull request that reopens or merges after NEEDS_ATTENTION', () => {
    expect(step('NEEDS_ATTENTION', { status: 'OPEN', type: 'pullRequest' }).state).toBe(
      'PR_OPENED'
    );
    expect(step('NEEDS_ATTENTION', { status: 'MERGED', type: 'pullRequest' }).state).toBe('MERGED');
    expect(step('NEEDS_ATTENTION', { status: 'CLOSED', type: 'pullRequest' })).toMatchObject({
      changed: false,
    });
  });

  it('never moves SKIPPED or CANCELLED', () => {
    const events: TargetEvent[] = [
      { type: 'retry' },
      { type: 'attemptStarted' },
      { satisfied: true, type: 'check' },
      { status: 'MERGED', type: 'pullRequest' },
      { type: 'remove' },
      { type: 'cancel' },
    ];
    for (const state of ['SKIPPED', 'CANCELLED'] as const) {
      for (const event of events) {
        expect(step(state, event)).toMatchObject({ accepted: false, changed: false, state });
      }
    }
  });

  it('reads a retired state as its replacement and reports the change', () => {
    expect(step('NOT_AFFECTED', { satisfied: false, type: 'check' }, 0)).toMatchObject({
      regressions: 1,
      state: 'PENDING',
    });
    expect(step('FAILED', { type: 'retry' }).state).toBe('PENDING');
    expect(step('FAILED', { couldNotRun: true, satisfied: false, type: 'check' })).toMatchObject({
      changed: true,
      state: 'NEEDS_ATTENTION',
    });
  });

  it('is total: every (state, event) pair answers with a real state and never throws', () => {
    const events: TargetEvent[] = [
      { type: 'block' },
      { type: 'unblock' },
      { type: 'attemptStarted' },
      { outcome: 'PR_OPENED', type: 'attemptFinished' },
      { outcome: 'FAILED', type: 'attemptFinished' },
      { status: 'OPEN', type: 'pullRequest' },
      { status: 'MERGED', type: 'pullRequest' },
      { status: 'CLOSED', type: 'pullRequest' },
      { satisfied: true, type: 'check' },
      { satisfied: false, type: 'check' },
      { couldNotRun: true, satisfied: false, type: 'check' },
      { type: 'retry' },
      { type: 'remove' },
      { type: 'cancel' },
    ];
    for (const state of CAMPAIGN_TARGET_STATE_VALUES) {
      for (const event of events) {
        const r = step(state, event);
        expect(CAMPAIGN_TARGET_STATE_VALUES).toContain(r.state);
        expect(r.state).not.toBe('NOT_AFFECTED');
        expect(r.state).not.toBe('FAILED');
        // Deterministic.
        expect(step(state, event)).toEqual(r);
        // A refused event never changes the state beyond normalising a retired one.
        if (!r.accepted) {
          expect(r.state).toBe(normalizeTargetState(state));
        }
      }
    }
  });
});

describe('computeTransitiveDependents', () => {
  it('returns the closure of dependents', () => {
    const nodes = [
      { dependsOn: [], id: 'A' },
      { dependsOn: ['A'], id: 'B' },
      { dependsOn: ['B'], id: 'C' },
      { dependsOn: [], id: 'D' },
    ];
    expect(computeTransitiveDependents('A', nodes)).toEqual(new Set(['B', 'C']));
    expect(computeTransitiveDependents('B', nodes)).toEqual(new Set(['C']));
    expect(computeTransitiveDependents('C', nodes)).toEqual(new Set());
    expect(computeTransitiveDependents('D', nodes)).toEqual(new Set());
  });

  it('handles a diamond once each', () => {
    const nodes = [
      { dependsOn: [], id: 'A' },
      { dependsOn: ['A'], id: 'B' },
      { dependsOn: ['A'], id: 'C' },
      { dependsOn: ['B', 'C'], id: 'D' },
    ];
    expect(computeTransitiveDependents('A', nodes)).toEqual(new Set(['B', 'C', 'D']));
  });

  it('never includes the failed target, even through a cycle', () => {
    const nodes = [
      { dependsOn: ['B'], id: 'A' },
      { dependsOn: ['A'], id: 'B' },
      { dependsOn: ['B'], id: 'C' },
    ];
    expect(computeTransitiveDependents('A', nodes)).toEqual(new Set(['B', 'C']));
    expect(computeTransitiveDependents('B', nodes)).toEqual(new Set(['A', 'C']));
  });

  it('ignores an unknown id and a self edge', () => {
    expect(computeTransitiveDependents('A', [{ dependsOn: ['A', 'zzz'], id: 'A' }])).toEqual(
      new Set()
    );
    expect(computeTransitiveDependents('missing', [{ dependsOn: [], id: 'A' }])).toEqual(new Set());
  });
});

function t(
  id: string,
  state: TargetState,
  position: number,
  dependsOn: string[] = []
): ScheduleTarget {
  return { dependsOn, id, label: `org/${id}`, position, state };
}

function schedule(targets: ScheduleTarget[], over: Partial<ScheduleInput> = {}) {
  return decideSchedule({
    campaignState: 'ACTIVE',
    gate: 'OPENED',
    hasCheck: true,
    maxOpenPullRequests: null,
    maxParallel: 10,
    targets,
    ...over,
  });
}

describe('decideSchedule', () => {
  it('starts pending targets in position order up to maxParallel, blocking the rest', () => {
    const r = schedule([t('c', 'PENDING', 2), t('a', 'PENDING', 0), t('b', 'PENDING', 1)], {
      maxParallel: 2,
    });
    expect(r.start).toEqual(['a', 'b']);
    expect(r.blocked).toEqual([{ reason: { kind: 'max-parallel', limit: 2 }, targetId: 'c' }]);
  });

  it('counts running children against maxParallel', () => {
    const r = schedule([t('a', 'RUNNING', 0), t('b', 'PENDING', 1), t('c', 'PENDING', 2)], {
      maxParallel: 2,
    });
    expect(r.start).toEqual(['b']);
    expect(r.blocked.map((b) => b.targetId)).toEqual(['c']);
  });

  it('starts nothing at maxParallel 0', () => {
    const r = schedule([t('a', 'PENDING', 0)], { maxParallel: 0 });
    expect(r.start).toEqual([]);
    expect(r.blocked[0]?.reason).toEqual({ kind: 'max-parallel', limit: 0 });
  });

  it('applies backpressure when drafts await review', () => {
    const targets = [t('a', 'PR_OPENED', 0), t('b', 'PR_OPENED', 1), t('c', 'PENDING', 2)];
    const full = schedule(targets, { maxOpenPullRequests: 2 });
    expect(full.start).toEqual([]);
    expect(full.blocked).toEqual([
      { reason: { kind: 'max-open-pull-requests', limit: 2 }, targetId: 'c' },
    ]);
    expect(schedule(targets, { maxOpenPullRequests: 3 }).start).toEqual(['c']);
    // No limit at all.
    expect(schedule(targets, { maxOpenPullRequests: null }).start).toEqual(['c']);
  });

  it('bounds open drafts: starts chosen in one decision count toward maxOpenPullRequests', () => {
    const r = schedule([t('a', 'PENDING', 0), t('b', 'PENDING', 1), t('c', 'PENDING', 2)], {
      maxOpenPullRequests: 1,
      maxParallel: 5,
    });
    expect(r.start).toEqual(['a']);
    expect(r.blocked.map((b) => b.reason)).toEqual([
      { kind: 'max-open-pull-requests', limit: 1 },
      { kind: 'max-open-pull-requests', limit: 1 },
    ]);
  });

  it('counts a running attempt as a future draft against maxOpenPullRequests', () => {
    const r = schedule([t('a', 'RUNNING', 0), t('b', 'PENDING', 1)], {
      maxOpenPullRequests: 1,
      maxParallel: 5,
    });
    expect(r.start).toEqual([]);
    expect(r.blocked[0]?.reason).toEqual({ kind: 'max-open-pull-requests', limit: 1 });
    // running + draft + new start share one bound
    const mixed = schedule(
      [t('a', 'RUNNING', 0), t('b', 'PR_OPENED', 1), t('c', 'PENDING', 2), t('d', 'PENDING', 3)],
      { maxOpenPullRequests: 3, maxParallel: 5 }
    );
    expect(mixed.start).toEqual(['c']);
  });

  it('re-evaluates BLOCKED targets and starts one whose reason cleared', () => {
    const r = schedule([t('a', 'BLOCKED', 0), t('b', 'PENDING', 1)], { maxParallel: 1 });
    expect(r.start).toEqual(['a']);
    expect(r.blocked.map((b) => b.targetId)).toEqual(['b']);
  });

  it('never starts a target in another state', () => {
    const r = schedule(
      (
        [
          'RUNNING',
          'PR_OPENED',
          'MERGED',
          'SATISFIED',
          'NEEDS_ATTENTION',
          'SKIPPED',
          'CANCELLED',
        ] as const
      ).map((s, i) => t(`x${i}`, s, i))
    );
    expect(r.start).toEqual([]);
    expect(r.blocked).toEqual([]);
  });

  describe('gates', () => {
    const chain = (upstream: TargetState, gate: CampaignGateValue, hasCheck = true) =>
      schedule([t('up', upstream, 0), t('down', 'PENDING', 1, ['up'])], { gate, hasCheck });

    it('OPENED opens once the upstream draft exists, merged or satisfied', () => {
      for (const s of ['PR_OPENED', 'MERGED', 'SATISFIED'] as const) {
        expect(chain(s, 'OPENED').start).toEqual(['down']);
      }
      for (const s of ['PENDING', 'BLOCKED', 'RUNNING'] as const) {
        const r = chain(s, 'OPENED');
        expect(r.start.includes('down')).toBe(false);
        expect(r.blocked.find((b) => b.targetId === 'down')?.reason).toEqual({
          kind: 'waiting-upstream',
          upstreamId: 'up',
          upstreamLabel: 'org/up',
        });
      }
    });

    it('MERGED opens only after the upstream is satisfied', () => {
      expect(chain('SATISFIED', 'MERGED').start).toEqual(['down']);
      for (const s of ['PR_OPENED', 'MERGED', 'RUNNING'] as const) {
        expect(chain(s, 'MERGED').start).not.toContain('down');
      }
    });

    it('MERGED treats a merge as the end for a campaign with no check', () => {
      expect(chain('MERGED', 'MERGED', false).start).toEqual(['down']);
      expect(chain('PR_OPENED', 'MERGED', false).start).not.toContain('down');
    });

    it('names a failed or skipped upstream', () => {
      for (const s of ['NEEDS_ATTENTION', 'SKIPPED', 'CANCELLED', 'FAILED'] as const) {
        const reason = chain(s, 'OPENED').blocked[0]?.reason;
        expect(reason).toEqual({
          kind: 'upstream-failed',
          upstreamId: 'up',
          upstreamLabel: 'org/up',
        });
      }
    });

    it('names the failed root for a transitive dependent', () => {
      const r = schedule([
        t('a', 'NEEDS_ATTENTION', 0),
        t('b', 'BLOCKED', 1, ['a']),
        t('c', 'PENDING', 2, ['b']),
      ]);
      const byId = new Map(r.blocked.map((b) => [b.targetId, b.reason]));
      expect(byId.get('b')).toEqual({
        kind: 'upstream-failed',
        upstreamId: 'a',
        upstreamLabel: 'org/a',
      });
      expect(byId.get('c')).toEqual({
        kind: 'upstream-failed',
        upstreamId: 'a',
        upstreamLabel: 'org/a',
      });
    });

    it('unblocks the rest once the failed upstream is retried', () => {
      const r = schedule([t('a', 'PENDING', 0), t('b', 'BLOCKED', 1, ['a'])]);
      expect(r.start).toEqual(['a']);
      expect(r.blocked).toEqual([
        {
          reason: { kind: 'waiting-upstream', upstreamId: 'a', upstreamLabel: 'org/a' },
          targetId: 'b',
        },
      ]);
    });

    it('reports a dependency cycle instead of waiting forever', () => {
      const r = schedule([t('a', 'PENDING', 0, ['b']), t('b', 'PENDING', 1, ['a'])]);
      expect(r.start).toEqual([]);
      expect(r.blocked.map((b) => b.reason)).toEqual([
        { kind: 'dependency-cycle' },
        { kind: 'dependency-cycle' },
      ]);
    });

    it('ignores a dependency that names no target and a self edge', () => {
      expect(schedule([t('a', 'PENDING', 0, ['gone', 'a'])]).start).toEqual(['a']);
    });

    it('requires every upstream gate to be open', () => {
      const r = schedule([
        t('u1', 'PR_OPENED', 0),
        t('u2', 'RUNNING', 1),
        t('d', 'PENDING', 2, ['u1', 'u2']),
      ]);
      expect(r.start).toEqual([]);
      expect(r.blocked[0]?.reason).toEqual({
        kind: 'waiting-upstream',
        upstreamId: 'u2',
        upstreamLabel: 'org/u2',
      });
    });
  });

  it('starts nothing, and leaves rows alone, unless the campaign is ACTIVE or STARTING', () => {
    for (const campaignState of CAMPAIGN_STATE_VALUES) {
      const r = schedule([t('a', 'PENDING', 0)], { campaignState });
      if (campaignState === 'ACTIVE' || campaignState === 'STARTING') {
        expect(r.start).toEqual(['a']);
        expect(r.held).toBeNull();
      } else {
        expect(r).toEqual({ blocked: [], held: 'campaign-not-active', start: [] });
      }
    }
  });

  it('is deterministic and breaks position ties by id', () => {
    const targets = [t('b', 'PENDING', 0), t('a', 'PENDING', 0)];
    expect(schedule(targets, { maxParallel: 1 }).start).toEqual(['a']);
    expect(schedule([...targets].reverse(), { maxParallel: 1 })).toEqual(
      schedule(targets, { maxParallel: 1 })
    );
  });

  it('describes every block reason', () => {
    const reasons: BlockReason[] = [
      { kind: 'waiting-upstream', upstreamId: 'u', upstreamLabel: 'org/u' },
      { kind: 'upstream-failed', upstreamId: 'u', upstreamLabel: 'org/u' },
      { kind: 'dependency-cycle' },
      { kind: 'max-parallel', limit: 3 },
      { kind: 'max-open-pull-requests', limit: 5 },
    ];
    const text = reasons.map(describeBlockReason);
    expect(text[0]).toContain('org/u');
    expect(text[1]).toContain('org/u');
    expect(text[3]).toContain('3');
    expect(text[4]).toContain('5');
    expect(new Set(text).size).toBe(reasons.length);
  });
});

describe('diffDiscovery', () => {
  const c = (
    id: string,
    over: Partial<{ reachable: boolean; satisfied: boolean | null; reason: string }> = {}
  ) => ({
    connectionId: id,
    label: `org/${id}`,
    reachable: over.reachable ?? true,
    satisfied: over.satisfied === undefined ? false : over.satisfied,
    teamId: 'team-1',
    unreachableReason: over.reason,
  });
  const base = {
    maxTargets: 10,
    proposalConnectionIds: [],
    targetConnectionIds: [],
    targetCount: 0,
  };

  it('adds unsatisfied reachable repositories in order', () => {
    const d = diffDiscovery({ ...base, candidates: [c('a'), c('b')] });
    expect(d.add.map((x) => x.connectionId)).toEqual(['a', 'b']);
    expect(d.propose).toEqual([]);
  });

  it('skips repositories that are already targets or proposals and duplicates', () => {
    const d = diffDiscovery({
      ...base,
      candidates: [c('a'), c('b'), c('c'), c('c')],
      proposalConnectionIds: ['b'],
      targetConnectionIds: ['a'],
    });
    expect(d.add.map((x) => x.connectionId)).toEqual(['c']);
    expect(d.propose).toEqual([]);
  });

  it('ignores satisfied repositories, reachable or not', () => {
    const d = diffDiscovery({
      ...base,
      candidates: [c('a', { satisfied: true }), c('b', { reachable: false, satisfied: true })],
    });
    expect(d).toEqual({ add: [], overLimit: [], propose: [], unchecked: [] });
  });

  it('proposes an unreachable, unsatisfied repository with the reason', () => {
    const d = diffDiscovery({
      ...base,
      candidates: [
        c('a', { reachable: false, reason: 'no push permission' }),
        c('b', { reachable: false }),
      ],
    });
    expect(d.add).toEqual([]);
    expect(d.propose[0]).toEqual({
      connectionId: 'a',
      label: 'org/a',
      reason: 'no push permission',
      teamId: 'team-1',
    });
    expect(d.propose[1]?.reason.length).toBeGreaterThan(0);
  });

  it('honours the target limit and defers the rest', () => {
    const d = diffDiscovery({
      ...base,
      candidates: [c('a'), c('b'), c('c')],
      maxTargets: 4,
      targetCount: 3,
    });
    expect(d.add.map((x) => x.connectionId)).toEqual(['a']);
    expect(d.overLimit.map((x) => x.connectionId)).toEqual(['b', 'c']);
  });

  it('still proposes past the limit, since a proposal is not a target', () => {
    const d = diffDiscovery({
      ...base,
      candidates: [c('a', { reachable: false })],
      maxTargets: 1,
      targetCount: 1,
    });
    expect(d.propose).toHaveLength(1);
  });

  it('adds nothing when the limit is already passed', () => {
    const d = diffDiscovery({ ...base, candidates: [c('a')], maxTargets: 2, targetCount: 5 });
    expect(d.add).toEqual([]);
    expect(d.overLimit).toHaveLength(1);
  });

  it('neither adds nor proposes a repository whose check could not run', () => {
    const d = diffDiscovery({ ...base, candidates: [c('a', { satisfied: null })] });
    expect(d.add).toEqual([]);
    expect(d.propose).toEqual([]);
    expect(d.unchecked.map((x) => x.connectionId)).toEqual(['a']);
  });
});

describe('decideStaleSince', () => {
  const opened = NOW - 10 * DAY;
  const base = {
    now: NOW,
    prOpenedAt: opened,
    prStatus: 'OPEN' as const,
    staleAfterDays: 7,
    staleSince: null,
    state: 'PR_OPENED' as TargetState,
  };

  it('marks a draft open past the threshold, at the moment it crossed', () => {
    expect(decideStaleSince(base)).toBe(opened + 7 * DAY);
  });

  it('is not stale before the threshold, and is stale exactly at it', () => {
    expect(decideStaleSince({ ...base, prOpenedAt: NOW - 6 * DAY })).toBeNull();
    expect(decideStaleSince({ ...base, prOpenedAt: NOW - 7 * DAY })).toBe(NOW);
  });

  it('keeps an existing staleSince', () => {
    expect(decideStaleSince({ ...base, staleSince: 123 })).toBe(123);
  });

  it('clears when the draft is no longer open or the target moved on', () => {
    expect(decideStaleSince({ ...base, prStatus: 'MERGED', staleSince: 123 })).toBeNull();
    expect(decideStaleSince({ ...base, staleSince: 123, state: 'SATISFIED' })).toBeNull();
    expect(decideStaleSince({ ...base, prStatus: null })).toBeNull();
    expect(decideStaleSince({ ...base, prOpenedAt: null })).toBeNull();
  });

  it('never flags without a positive threshold', () => {
    expect(decideStaleSince({ ...base, staleAfterDays: null })).toBeNull();
    expect(decideStaleSince({ ...base, staleAfterDays: 0 })).toBeNull();
    expect(decideStaleSince({ ...base, staleAfterDays: -3 })).toBeNull();
  });
});

describe('isDue / nextDueAt', () => {
  it('is due when never run, or the interval has passed', () => {
    expect(isDue(null, NOW, 24)).toBe(true);
    expect(isDue(NOW - 24 * HOUR, NOW, 24)).toBe(true);
    expect(isDue(NOW - 23 * HOUR, NOW, 24)).toBe(false);
  });

  it('is never due without a positive interval', () => {
    expect(isDue(null, NOW, null)).toBe(false);
    expect(isDue(null, NOW, 0)).toBe(false);
    expect(nextDueAt(null, NOW, null)).toBeNull();
    expect(nextDueAt(null, NOW, 0)).toBeNull();
  });

  it('reports when the next run falls due', () => {
    expect(nextDueAt(null, NOW, 6)).toBe(NOW);
    expect(nextDueAt(NOW - HOUR, NOW, 6)).toBe(NOW + 5 * HOUR);
  });
});

describe('decideCampaignState', () => {
  const decide = (
    state: CampaignStateValue,
    targetStates: TargetState[],
    over: { hasScope?: boolean; expiresAt?: number | null; hasCheck?: boolean } = {}
  ) =>
    decideCampaignState({
      expiresAt: over.expiresAt ?? null,
      hasCheck: over.hasCheck ?? true,
      hasScope: over.hasScope ?? false,
      now: NOW,
      state,
      targetStates,
    });

  it('stays ACTIVE while any target is not final', () => {
    for (const s of [
      'PENDING',
      'BLOCKED',
      'RUNNING',
      'PR_OPENED',
      'MERGED',
      'NEEDS_ATTENTION',
      'FAILED',
    ] as const) {
      expect(decide('ACTIVE', ['SATISFIED', s])).toEqual({ changed: false, state: 'ACTIVE' });
    }
  });

  it('treats MERGED as final only for a campaign with no check', () => {
    expect(isTargetFinalFor('MERGED', { hasCheck: false })).toBe(true);
    expect(isTargetFinalFor('MERGED', { hasCheck: true })).toBe(false);
    expect(isTargetFinalFor('SATISFIED', { hasCheck: true })).toBe(true);
    expect(isTargetFinalFor('PR_OPENED', { hasCheck: false })).toBe(false);
    expect(decide('ACTIVE', ['MERGED', 'SKIPPED'], { hasCheck: false })).toEqual({
      changed: true,
      state: 'COMPLETED',
    });
    expect(decide('ACTIVE', ['MERGED'], { hasCheck: false, hasScope: true }).state).toBe(
      'MONITORING'
    );
    expect(decide('ACTIVE', ['MERGED'], { hasCheck: true }).state).toBe('ACTIVE');
  });

  it('completes when every target is final and there is no scope', () => {
    expect(decide('ACTIVE', ['SATISFIED', 'SKIPPED', 'CANCELLED', 'NOT_AFFECTED'])).toEqual({
      changed: true,
      state: 'COMPLETED',
    });
    expect(decide('ACTIVE', [])).toEqual({ changed: true, state: 'COMPLETED' });
  });

  it('monitors when every target is final and a scope is set', () => {
    expect(decide('ACTIVE', ['SATISFIED'], { hasScope: true })).toEqual({
      changed: true,
      state: 'MONITORING',
    });
    expect(decide('ACTIVE', [], { hasScope: true }).state).toBe('MONITORING');
    expect(decide('MONITORING', ['SATISFIED'], { hasScope: true })).toEqual({
      changed: false,
      state: 'MONITORING',
    });
  });

  it('completes at expiry even with a scope, and not before', () => {
    expect(decide('MONITORING', ['SATISFIED'], { expiresAt: NOW, hasScope: true }).state).toBe(
      'COMPLETED'
    );
    expect(decide('ACTIVE', ['SATISFIED'], { expiresAt: NOW - 1, hasScope: true }).state).toBe(
      'COMPLETED'
    );
    expect(decide('MONITORING', ['SATISFIED'], { expiresAt: NOW + 1, hasScope: true }).state).toBe(
      'MONITORING'
    );
  });

  it('does not complete an expired campaign that still has work waiting', () => {
    expect(
      decide('ACTIVE', ['NEEDS_ATTENTION'], { expiresAt: NOW - DAY, hasScope: true }).state
    ).toBe('ACTIVE');
  });

  it('returns a MONITORING campaign to ACTIVE when a target regresses', () => {
    expect(decide('MONITORING', ['PENDING', 'SATISFIED'], { hasScope: true })).toEqual({
      changed: true,
      state: 'ACTIVE',
    });
  });

  it('never moves any other state', () => {
    for (const state of CAMPAIGN_STATE_VALUES) {
      if (state === 'ACTIVE' || state === 'MONITORING') {
        continue;
      }
      expect(decide(state, ['SATISFIED'])).toEqual({ changed: false, state });
    }
  });
});

describe('decidePause', () => {
  const ok = { budgetExceeded: false, campaignsEnabled: true, launcherAvailable: true };

  it('pauses by priority: disabled, then launcher, then budget', () => {
    expect(decidePause({ ...ok, state: 'ACTIVE' })).toBeNull();
    expect(decidePause({ ...ok, budgetExceeded: true, state: 'ACTIVE' })).toBe('budget');
    expect(
      decidePause({ ...ok, budgetExceeded: true, launcherAvailable: false, state: 'ACTIVE' })
    ).toBe('launcher-unavailable');
    expect(
      decidePause({
        budgetExceeded: true,
        campaignsEnabled: false,
        launcherAvailable: false,
        state: 'MONITORING',
      })
    ).toBe('disabled');
  });

  it('applies only to a campaign that is running', () => {
    for (const state of ['PAUSED', 'PLANNING', 'CANCELLING', 'CANCELLED', 'COMPLETED'] as const) {
      expect(decidePause({ ...ok, campaignsEnabled: false, state })).toBeNull();
    }
    expect(decidePause({ ...ok, campaignsEnabled: false, state: 'STARTING' })).toBe('disabled');
  });
});

describe('countTargets', () => {
  it('counts every state and folds the retired ones', () => {
    const counts = countTargets([
      'PENDING',
      'BLOCKED',
      'BLOCKED',
      'RUNNING',
      'PR_OPENED',
      'MERGED',
      'SATISFIED',
      'NOT_AFFECTED',
      'NEEDS_ATTENTION',
      'FAILED',
      'SKIPPED',
      'CANCELLED',
    ]);
    expect(counts).toEqual({
      blocked: 2,
      cancelled: 1,
      merged: 1,
      needsAttention: 2,
      pending: 1,
      prOpened: 1,
      running: 1,
      satisfied: 2,
      skipped: 1,
      total: 12,
    });
  });

  it('answers zeros for no targets', () => {
    expect(countTargets([]).total).toBe(0);
    expect(countTargets([]).satisfied).toBe(0);
  });
});
