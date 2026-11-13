import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_FAILURE_REASON_MAX,
  campaignFinalState,
  campaignTargetOutcome,
} from './campaignOutcome.js';

const live = { cancelled: false };

describe('campaignTargetOutcome', () => {
  it('maps SUCCESS with a pull request to PR_OPENED', () => {
    expect(
      campaignTargetOutcome(
        {
          changed: true,
          path: 'RECIPE',
          prNumber: 12,
          prUrl: 'https://github.com/o/r/pull/12',
          status: 'SUCCESS',
          verification: 'PASSED',
        } as never,
        live
      )
    ).toEqual({
      failureReason: null,
      path: 'RECIPE',
      prNumber: 12,
      prUrl: 'https://github.com/o/r/pull/12',
      state: 'PR_OPENED',
      verification: 'PASSED',
    });
  });

  it('reads the pull request number from the URL when the result has none', () => {
    const o = campaignTargetOutcome(
      { prUrl: 'https://ghe.example/o/r/pull/345', status: 'SUCCESS' },
      live
    );
    expect(o.prNumber).toBe(345);
  });

  it('ignores a non-integer or non-positive pull request number', () => {
    for (const prNumber of [1.5, 0, -3, '7', Number.NaN]) {
      const o = campaignTargetOutcome(
        { prNumber, prUrl: 'https://x/o/r/pull/9', status: 'SUCCESS' } as never,
        live
      );
      expect(o.prNumber).toBe(9);
    }
  });

  it('does not accept a non-http pull request URL', () => {
    const o = campaignTargetOutcome(
      { changed: false, prUrl: 'javascript:alert(1)', status: 'SUCCESS' } as never,
      live
    );
    expect(o.state).toBe('NOT_AFFECTED');
    expect(o.prUrl).toBeNull();
  });

  it('maps SUCCESS with changed === false to NOT_AFFECTED', () => {
    expect(
      campaignTargetOutcome(
        { changed: false, path: 'NONE', status: 'SUCCESS', verification: 'NOT_RUN' } as never,
        live
      )
    ).toMatchObject({ path: 'NONE', state: 'NOT_AFFECTED', verification: 'NOT_RUN' });
  });

  it('fails a SUCCESS that neither opened a pull request nor said nothing changed', () => {
    const o = campaignTargetOutcome({ status: 'SUCCESS' }, live);
    expect(o.state).toBe('FAILED');
    expect(o.failureReason).toMatch(/without opening a pull request/);
  });

  it.each([
    ['FAILED', 'FAILED'],
    ['TIMED_OUT', 'FAILED'],
    ['SKIPPED', 'SKIPPED'],
  ] as const)('maps %s to %s', (status, state) => {
    const o = campaignTargetOutcome({ skippedReason: 'because', status }, live);
    expect(o.state).toBe(state);
    expect(o.failureReason).toBe('because');
    expect(o.prUrl).toBeNull();
  });

  it('gives a default reason when the child names none', () => {
    expect(campaignTargetOutcome({ status: 'FAILED' }, live).failureReason).toBeTruthy();
    expect(campaignTargetOutcome({ status: 'TIMED_OUT' }, live).failureReason).toMatch(/timed out/);
  });

  it('maps an unfinished child to CANCELLED once the campaign was cancelled', () => {
    for (const status of ['FAILED', 'TIMED_OUT', 'SKIPPED'] as const) {
      const o = campaignTargetOutcome(
        { skippedReason: 'campaign cancelled', status },
        {
          cancelled: true,
        }
      );
      expect(o).toMatchObject({ failureReason: null, state: 'CANCELLED' });
    }
  });

  it('keeps the outcome of a child that finished before the cancel', () => {
    const pr = campaignTargetOutcome(
      { prUrl: 'https://h/o/r/pull/1', status: 'SUCCESS' },
      {
        cancelled: true,
      }
    );
    expect(pr.state).toBe('PR_OPENED');
    const none = campaignTargetOutcome({ changed: false, status: 'SUCCESS' } as never, {
      cancelled: true,
    });
    expect(none.state).toBe('NOT_AFFECTED');
  });

  it('turns an unknown path or verification into null', () => {
    const o = campaignTargetOutcome(
      { path: 'TELEPORT', status: 'FAILED', verification: 'MAYBE' } as never,
      live
    );
    expect(o.path).toBeNull();
    expect(o.verification).toBeNull();
    const nonString = campaignTargetOutcome(
      { path: 3, status: 'FAILED', verification: {} } as never,
      live
    );
    expect(nonString.path).toBeNull();
    expect(nonString.verification).toBeNull();
  });

  it('masks before it truncates, so a cut token cannot survive', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const text = `${'x'.repeat(CAMPAIGN_FAILURE_REASON_MAX - 10)} ${token} tail`;
    const o = campaignTargetOutcome(
      { skippedReason: text, status: 'FAILED' },
      {
        cancelled: false,
        mask: (s) => s.replace(/ghp_[A-Za-z0-9]+/g, '***'),
      }
    );
    expect(o.failureReason).not.toContain('ghp_');
    expect(o.failureReason?.length).toBeLessThanOrEqual(CAMPAIGN_FAILURE_REASON_MAX);
  });

  it('truncates a long reason and strips control characters', () => {
    const o = campaignTargetOutcome(
      { skippedReason: `a\u0000b\nc${'z'.repeat(2000)}`, status: 'FAILED' },
      live
    );
    expect(o.failureReason?.length).toBe(CAMPAIGN_FAILURE_REASON_MAX);
    expect(o.failureReason).toMatch(/^a b c/);
    expect(o.failureReason?.endsWith('…')).toBe(true);
  });
});

describe('campaignFinalState', () => {
  it('is CANCELLED when cancelled, whatever the targets did', () => {
    expect(campaignFinalState(['PR_OPENED', 'FAILED'], true)).toBe('CANCELLED');
  });
  it('is COMPLETED_WITH_FAILURES when a target failed or was skipped', () => {
    expect(campaignFinalState(['PR_OPENED', 'FAILED'], false)).toBe('COMPLETED_WITH_FAILURES');
    expect(campaignFinalState(['NOT_AFFECTED', 'SKIPPED'], false)).toBe('COMPLETED_WITH_FAILURES');
  });
  it('is COMPLETED when every target opened a pull request or was not affected', () => {
    expect(campaignFinalState(['PR_OPENED', 'NOT_AFFECTED'], false)).toBe('COMPLETED');
    expect(campaignFinalState([], false)).toBe('COMPLETED');
  });
});
