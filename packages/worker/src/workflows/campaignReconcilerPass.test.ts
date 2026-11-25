import {
  CAMPAIGN_BACKSTOP_INTERVAL_MS,
  decideSchedule,
  type TargetState,
} from '@auto-swe/shared/lib/campaignState';
import { describe, expect, it } from 'vitest';
import type { PassTarget } from '../lib/campaignReconcilerTypes.js';
import {
  ATTEMPT_FAILED_REASON,
  applyCheckResult,
  CANCELLED_OUTSIDE_REASON,
  CHECK_RETRY_MS,
  decideBlockUpdates,
  decideCampaignWrite,
  deriveDeliveryUpdates,
  discoveryDue,
  INFLIGHT_POLL_MS,
  MAX_CHECKS_PER_PASS,
  MIN_SLEEP_MS,
  nextSleepMs,
  PR_CLOSED_REASON,
  planDueChecks,
} from './campaignReconcilerPass.js';
import { makeCampaign, makeTarget, T0 } from './testing/campaignReconcilerWorld.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const t = (id: string, over: Partial<PassTarget> = {}) => makeTarget(id, over);

describe('deriveDeliveryUpdates', () => {
  const opts = { now: T0, staleAfterDays: null };

  it('moves a target whose attempt opened a draft that has since merged, in one update', () => {
    const { updates, targets } = deriveDeliveryUpdates(
      [t('t1', { attemptOutcome: 'PR_OPENED', prStatus: 'MERGED', state: 'RUNNING' })],
      opts
    );
    expect(updates).toEqual([
      { expect: 'RUNNING', regressions: 0, state: 'MERGED', targetId: 't1', teamId: 'team-a' },
    ]);
    expect(targets[0]?.state).toBe('MERGED');
  });

  it('records a failed attempt as NEEDS_ATTENTION with the attempt’s reason', () => {
    const { updates } = deriveDeliveryUpdates(
      [
        t('t1', {
          attemptFailureReason: 'the original tests failed',
          attemptOutcome: 'FAILED',
          state: 'RUNNING',
        }),
        t('t2', { attemptOutcome: 'FAILED', state: 'RUNNING' }),
      ],
      opts
    );
    expect(updates.map((u) => [u.targetId, u.state, u.failureReason])).toEqual([
      ['t1', 'NEEDS_ATTENTION', 'the original tests failed'],
      ['t2', 'NEEDS_ATTENTION', ATTEMPT_FAILED_REASON],
    ]);
  });

  it('reads an attempt cancelled outside the campaign as needing a person, not as CANCELLED', () => {
    const { updates } = deriveDeliveryUpdates(
      [t('t1', { attemptOutcome: 'CANCELLED', state: 'RUNNING' })],
      opts
    );
    expect(updates[0]).toMatchObject({
      failureReason: CANCELLED_OUTSIDE_REASON,
      state: 'NEEDS_ATTENTION',
    });
  });

  it('sends a draft closed unmerged to NEEDS_ATTENTION, and brings it back when it is reopened', () => {
    const closed = deriveDeliveryUpdates(
      [t('t1', { prStatus: 'CLOSED', state: 'PR_OPENED' })],
      opts
    );
    expect(closed.updates[0]).toMatchObject({
      failureReason: PR_CLOSED_REASON,
      state: 'NEEDS_ATTENTION',
    });
    const reopened = deriveDeliveryUpdates(
      [t('t1', { failureReason: PR_CLOSED_REASON, prStatus: 'OPEN', state: 'NEEDS_ATTENTION' })],
      opts
    );
    expect(reopened.updates[0]).toMatchObject({ failureReason: null, state: 'PR_OPENED' });
  });

  it('does not let a merged pull request flip a NEEDS_ATTENTION target back and forth', () => {
    const { updates } = deriveDeliveryUpdates(
      [t('t1', { prStatus: 'MERGED', state: 'NEEDS_ATTENTION' })],
      opts
    );
    expect(updates).toEqual([]);
  });

  it('leaves a running attempt, an open draft and a satisfied target alone', () => {
    const { updates } = deriveDeliveryUpdates(
      [
        t('t1', { state: 'RUNNING' }),
        t('t2', { prStatus: 'OPEN', state: 'PR_OPENED' }),
        t('t3', { prStatus: 'MERGED', state: 'SATISFIED' }),
        t('t4', { state: 'PENDING' }),
      ],
      opts
    );
    expect(updates).toEqual([]);
  });

  it('reads a retired state as its replacement and writes nothing for it', () => {
    const { updates, targets } = deriveDeliveryUpdates(
      [t('t1', { state: 'NOT_AFFECTED' as TargetState })],
      opts
    );
    expect(updates).toEqual([]);
    expect(targets[0]?.state).toBe('NOT_AFFECTED');
  });

  it('sets the stale flag at the moment the draft crossed the line, and clears it when it merges', () => {
    const openedAt = T0 - 10 * DAY;
    const stale = deriveDeliveryUpdates(
      [t('t1', { prOpenedAt: openedAt, prStatus: 'OPEN', state: 'PR_OPENED' })],
      { now: T0, staleAfterDays: 7 }
    );
    expect(stale.updates).toEqual([
      {
        expect: 'PR_OPENED',
        staleSince: openedAt + 7 * DAY,
        state: 'PR_OPENED',
        targetId: 't1',
        teamId: 'team-a',
      },
    ]);
    // Already flagged: nothing to write.
    expect(
      deriveDeliveryUpdates(
        [
          t('t1', {
            prOpenedAt: openedAt,
            prStatus: 'OPEN',
            staleSince: openedAt + 7 * DAY,
            state: 'PR_OPENED',
          }),
        ],
        { now: T0, staleAfterDays: 7 }
      ).updates
    ).toEqual([]);
    const merged = deriveDeliveryUpdates(
      [
        t('t1', {
          prOpenedAt: openedAt,
          prStatus: 'MERGED',
          staleSince: openedAt + 7 * DAY,
          state: 'PR_OPENED',
        }),
      ],
      { now: T0, staleAfterDays: 7 }
    );
    expect(merged.updates[0]).toMatchObject({ staleSince: null, state: 'MERGED' });
  });
});

describe('planDueChecks', () => {
  const campaign = { hasCheck: true, rescanIntervalHours: 24 };

  it('checks a merged target at once and a satisfied one when its rescan is due', () => {
    const { due } = planDueChecks(
      [
        t('t1', { state: 'MERGED' }),
        t('t2', { lastCheckedAt: T0 - 25 * HOUR, state: 'SATISFIED' }),
        t('t3', { lastCheckedAt: T0 - HOUR, state: 'SATISFIED' }),
        t('t4', { state: 'PR_OPENED' }),
      ],
      campaign,
      T0
    );
    expect(due).toEqual(['t1', 't2']);
  });

  it('waits before checking a merged target again when the check could not run', () => {
    expect(
      planDueChecks(
        [t('t1', { lastCheckedAt: T0 - CHECK_RETRY_MS + 1, state: 'MERGED' })],
        campaign,
        T0
      ).due
    ).toEqual([]);
    expect(
      planDueChecks(
        [t('t1', { lastCheckedAt: T0 - CHECK_RETRY_MS, state: 'MERGED' })],
        campaign,
        T0
      ).due
    ).toEqual(['t1']);
  });

  it('checks nothing for a campaign without a check, and skips targets named in exclude', () => {
    expect(
      planDueChecks(
        [t('t1', { state: 'MERGED' })],
        { hasCheck: false, rescanIntervalHours: 24 },
        T0
      ).due
    ).toEqual([]);
    expect(
      planDueChecks([t('t1', { state: 'MERGED' })], campaign, T0, new Set(['t1'])).due
    ).toEqual([]);
  });

  it('never rescans a satisfied target of a campaign with no rescan interval', () => {
    expect(
      planDueChecks(
        [t('t1', { lastCheckedAt: 0, state: 'SATISFIED' })],
        { hasCheck: true, rescanIntervalHours: null },
        T0
      ).due
    ).toEqual([]);
  });

  it('caps a pass and says there is more', () => {
    const many = Array.from({ length: MAX_CHECKS_PER_PASS + 3 }, (_, i) =>
      t(`t${i + 1}`, { state: 'MERGED' })
    );
    const r = planDueChecks(many, campaign, T0);
    expect(r.due).toHaveLength(MAX_CHECKS_PER_PASS);
    expect(r.more).toBe(true);
    expect(r.due[0]).toBe('t1');
  });
});

describe('applyCheckResult', () => {
  it('carries the answer onto the target', () => {
    const next = applyCheckResult(t('t1', { state: 'MERGED' }), {
      changed: true,
      failureReason: null,
      lastCheckedAt: T0,
      regressions: 0,
      state: 'SATISFIED',
      status: 'satisfied',
      targetId: 't1',
    });
    expect(next).toMatchObject({ lastCheckedAt: T0, state: 'SATISFIED' });
  });

  it('keeps the state when the check moved nothing', () => {
    const next = applyCheckResult(t('t1', { state: 'MERGED' }), {
      changed: false,
      lastCheckedAt: T0,
      reason: 'the check could not run',
      regressions: 0,
      state: 'MERGED',
      status: 'could-not-run',
      targetId: 't1',
    });
    expect(next.state).toBe('MERGED');
    expect(next.lastCheckedAt).toBe(T0);
  });
});

describe('decideBlockUpdates', () => {
  it('blocks a held-back PENDING target with the reason, and frees a BLOCKED one that starts', () => {
    const targets = [
      t('t1', { state: 'RUNNING' }),
      t('t2', { dependsOn: ['t1'], state: 'PENDING' }),
      t('t3', { failureReason: 'old reason', state: 'BLOCKED' }),
    ];
    const schedule = decideSchedule({
      campaignState: 'ACTIVE',
      gate: 'OPENED',
      hasCheck: false,
      maxOpenPullRequests: null,
      maxParallel: 3,
      targets,
    });
    const { updates } = decideBlockUpdates(schedule, targets);
    expect(updates).toEqual([
      {
        expect: 'PENDING',
        failureReason: 'Waiting for acme/t1',
        state: 'BLOCKED',
        targetId: 't2',
        teamId: 'team-a',
      },
      {
        expect: 'BLOCKED',
        failureReason: null,
        state: 'PENDING',
        targetId: 't3',
        teamId: 'team-a',
      },
    ]);
  });

  it('writes nothing for a BLOCKED target whose reason is unchanged', () => {
    const targets = [
      t('t1', { state: 'RUNNING' }),
      t('t2', { dependsOn: ['t1'], failureReason: 'Waiting for acme/t1', state: 'BLOCKED' }),
    ];
    const schedule = decideSchedule({
      campaignState: 'ACTIVE',
      gate: 'OPENED',
      hasCheck: false,
      maxOpenPullRequests: null,
      maxParallel: 3,
      targets,
    });
    expect(decideBlockUpdates(schedule, targets).updates).toEqual([]);
  });
});

describe('decideCampaignWrite', () => {
  const base = { expiresAt: null, hasScope: false };

  it('reads STARTING as ACTIVE and writes the move', () => {
    const r = decideCampaignWrite({ ...base, state: 'STARTING' }, [t('t1')], T0);
    expect(r).toEqual({ state: 'ACTIVE', write: { from: 'STARTING', to: 'ACTIVE' } });
  });

  it('completes an ACTIVE campaign whose targets are all final and that has no scope', () => {
    const r = decideCampaignWrite(
      { ...base, state: 'ACTIVE' },
      [t('t1', { state: 'SATISFIED' }), t('t2', { state: 'SKIPPED' })],
      T0
    );
    expect(r.write).toEqual({ from: 'ACTIVE', to: 'COMPLETED' });
  });

  it('monitors a campaign with a scope, and wakes it when a target regressed', () => {
    const monitoring = decideCampaignWrite(
      { ...base, hasScope: true, state: 'ACTIVE' },
      [t('t1', { state: 'SATISFIED' })],
      T0
    );
    expect(monitoring.write).toEqual({ from: 'ACTIVE', to: 'MONITORING' });
    const regressed = decideCampaignWrite(
      { ...base, hasScope: true, state: 'MONITORING' },
      [t('t1', { state: 'PENDING' })],
      T0
    );
    expect(regressed.write).toEqual({ from: 'MONITORING', to: 'ACTIVE' });
  });

  it('completes a monitored campaign at its expiry', () => {
    const r = decideCampaignWrite(
      { expiresAt: T0 - 1, hasScope: true, state: 'MONITORING' },
      [t('t1', { state: 'SATISFIED' })],
      T0
    );
    expect(r.write).toEqual({ from: 'MONITORING', to: 'COMPLETED' });
  });

  it('never moves a paused or planning campaign', () => {
    expect(decideCampaignWrite({ ...base, state: 'PAUSED' }, [t('t1')], T0).write).toBeNull();
    expect(decideCampaignWrite({ ...base, state: 'PLANNING' }, [t('t1')], T0).write).toBeNull();
  });

  it('leaves an ACTIVE campaign with work left as it is', () => {
    expect(decideCampaignWrite({ ...base, state: 'ACTIVE' }, [t('t1')], T0).write).toBeNull();
  });
});

describe('discoveryDue', () => {
  const c = { expiresAt: null, hasCheck: true, hasScope: true, rescanIntervalHours: 24 };

  it('is due when never run, or after the interval, and only with a scope and a check', () => {
    expect(discoveryDue(c, null, T0)).toBe(true);
    expect(discoveryDue(c, T0 - 25 * HOUR, T0)).toBe(true);
    expect(discoveryDue(c, T0 - HOUR, T0)).toBe(false);
    expect(discoveryDue({ ...c, hasScope: false }, null, T0)).toBe(false);
    expect(discoveryDue({ ...c, hasCheck: false }, null, T0)).toBe(false);
  });

  it('stops at the campaign’s expiry', () => {
    expect(discoveryDue({ ...c, expiresAt: T0 - 1 }, null, T0)).toBe(false);
  });
});

describe('nextSleepMs', () => {
  const input = {
    campaign: makeCampaign({ hasCheck: true, rescanIntervalHours: 24 }),
    discoveryFailed: false,
    excluded: new Set<string>(),
    lastBackstopAt: T0,
    lastDiscoveryAt: null as number | null,
    now: T0,
    retryAt: null as number | null,
    state: 'ACTIVE' as const,
    targets: [] as PassTarget[],
  };

  it('sleeps until the daily backstop when nothing is due', () => {
    expect(nextSleepMs({ ...input, lastDiscoveryAt: T0 })).toBe(CAMPAIGN_BACKSTOP_INTERVAL_MS);
  });

  it('polls while an attempt is in flight, in case its signal is lost', () => {
    expect(nextSleepMs({ ...input, targets: [t('t1', { state: 'RUNNING' })] })).toBe(
      INFLIGHT_POLL_MS
    );
  });

  it('wakes for the next rescan of a satisfied target', () => {
    expect(
      nextSleepMs({
        ...input,
        targets: [t('t1', { lastCheckedAt: T0 - 20 * HOUR, state: 'SATISFIED' })],
      })
    ).toBe(4 * HOUR);
  });

  it('wakes for the moment a draft turns stale, and for the campaign’s expiry', () => {
    const openedAt = T0 - 6 * DAY;
    expect(
      nextSleepMs({
        ...input,
        campaign: makeCampaign({ staleAfterDays: 7 }),
        targets: [t('t1', { prOpenedAt: openedAt, prStatus: 'OPEN', state: 'PR_OPENED' })],
      })
    ).toBe(DAY);
    expect(nextSleepMs({ ...input, campaign: makeCampaign({ expiresAt: T0 + 3 * HOUR }) })).toBe(
      3 * HOUR
    );
  });

  it('sleeps only a second when work is due now, and never less', () => {
    expect(nextSleepMs({ ...input, targets: [t('t1', { state: 'MERGED' })] })).toBe(MIN_SLEEP_MS);
  });

  it('waits for the retry time after a failure instead of spinning on due work', () => {
    expect(
      nextSleepMs({
        ...input,
        excluded: new Set(['t1']),
        retryAt: T0 + 5 * 60_000,
        targets: [t('t1', { state: 'MERGED' })],
      })
    ).toBe(5 * 60_000);
  });

  it('does not wake a paused campaign for checks or discovery', () => {
    expect(
      nextSleepMs({
        ...input,
        state: 'PAUSED',
        targets: [t('t1', { lastCheckedAt: 0, state: 'SATISFIED' })],
      })
    ).toBe(CAMPAIGN_BACKSTOP_INTERVAL_MS);
  });
});
