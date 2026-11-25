import { describe, expect, it } from 'vitest';
import {
  JoinRequestNotificationAudience,
  JoinRequestNotificationChannel,
  JoinRequestNotificationEvent,
  JoinRequestNotificationStatus,
} from '../generated/prisma/enums.js';
import {
  AUDIENCE_CHANNEL,
  canTransitionNotification,
  capRecipients,
  isNotificationRetryable,
  JOIN_REQUEST_NOTIFICATION_AUDIENCES,
  JOIN_REQUEST_NOTIFICATION_CHANNELS,
  JOIN_REQUEST_NOTIFICATION_ERROR_CODES,
  JOIN_REQUEST_NOTIFICATION_EVENTS,
  JOIN_REQUEST_NOTIFICATION_STATUSES,
  JOIN_REQUEST_NOTIFICATION_TRANSITIONS,
  MAX_NOTIFICATION_ATTEMPTS,
  MAX_NOTIFICATION_RECIPIENTS,
  mergeReached,
  NOTIFICATION_BACKOFF_MS,
  nextAttempt,
  outcomeAfterFailure,
  retryReset,
  routeAudiences,
} from './teamJoinRequests.js';

const now = new Date('2026-11-24T10:00:00.000Z');

describe('notification vocabulary', () => {
  it('matches the Prisma enums', () => {
    expect([...JOIN_REQUEST_NOTIFICATION_EVENTS].sort()).toEqual(
      Object.values(JoinRequestNotificationEvent).sort()
    );
    expect([...JOIN_REQUEST_NOTIFICATION_CHANNELS].sort()).toEqual(
      Object.values(JoinRequestNotificationChannel).sort()
    );
    expect([...JOIN_REQUEST_NOTIFICATION_AUDIENCES].sort()).toEqual(
      Object.values(JoinRequestNotificationAudience).sort()
    );
    expect([...JOIN_REQUEST_NOTIFICATION_STATUSES].sort()).toEqual(
      Object.values(JoinRequestNotificationStatus).sort()
    );
  });

  it('keeps error codes fixed-shape (no spaces, addresses or bodies)', () => {
    for (const code of JOIN_REQUEST_NOTIFICATION_ERROR_CODES) {
      expect(code).toMatch(/^[a-z_]+$/);
    }
    expect(JOIN_REQUEST_NOTIFICATION_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'transport_not_configured',
        'transport_error',
        'slack_error',
        'no_recipients',
      ])
    );
  });
});

describe('notification state machine', () => {
  it('has a transition entry for every status', () => {
    expect(Object.keys(JOIN_REQUEST_NOTIFICATION_TRANSITIONS).sort()).toEqual(
      [...JOIN_REQUEST_NOTIFICATION_STATUSES].sort()
    );
  });

  it('moves PENDING to a result and FAILED back to PENDING only', () => {
    expect(canTransitionNotification('PENDING', 'DELIVERED')).toBe(true);
    expect(canTransitionNotification('PENDING', 'SKIPPED')).toBe(true);
    expect(canTransitionNotification('PENDING', 'FAILED')).toBe(true);
    expect(canTransitionNotification('FAILED', 'PENDING')).toBe(true);
    expect(canTransitionNotification('FAILED', 'DELIVERED')).toBe(false);
    expect(canTransitionNotification('DELIVERED', 'PENDING')).toBe(false);
    expect(canTransitionNotification('SKIPPED', 'PENDING')).toBe(false);
    expect(canTransitionNotification('PENDING', 'PENDING')).toBe(false);
  });

  it('allows an admin retry of FAILED rows only', () => {
    expect(JOIN_REQUEST_NOTIFICATION_STATUSES.filter(isNotificationRetryable)).toEqual(['FAILED']);
  });

  it('resets attempts, due now, error cleared on retry', () => {
    expect(retryReset(now)).toEqual({
      attempts: 0,
      lastError: null,
      nextAttemptAt: now,
      status: 'PENDING',
    });
  });
});

describe('backoff', () => {
  it('uses 30 s, 2 min, 10 min, 1 h, 6 h', () => {
    expect(NOTIFICATION_BACKOFF_MS).toEqual([30_000, 120_000, 600_000, 3_600_000, 21_600_000]);
    expect(MAX_NOTIFICATION_ATTEMPTS).toBe(6);
  });

  it('schedules each of the first five failures and stops at the sixth', () => {
    const delays = [1, 2, 3, 4, 5].map(
      (n) => (nextAttempt(n, now)?.getTime() ?? Number.NaN) - now.getTime()
    );
    expect(delays).toEqual(NOTIFICATION_BACKOFF_MS);
    expect(nextAttempt(6, now)).toBeNull();
    expect(nextAttempt(7, now)).toBeNull();
  });

  it('refuses a nonsense attempt count', () => {
    expect(nextAttempt(0, now)).toBeNull();
    expect(nextAttempt(-1, now)).toBeNull();
    expect(nextAttempt(1.5, now)).toBeNull();
  });

  it('turns a failure into a retry or a final FAILED', () => {
    expect(outcomeAfterFailure(0, now)).toEqual({
      attempts: 1,
      nextAttemptAt: new Date(now.getTime() + 30_000),
      status: 'PENDING',
    });
    expect(outcomeAfterFailure(4, now)).toMatchObject({ attempts: 5, status: 'PENDING' });
    expect(outcomeAfterFailure(5, now)).toEqual({
      attempts: 6,
      nextAttemptAt: null,
      status: 'FAILED',
    });
  });
});

describe('routeAudiences', () => {
  const route = (
    event: Parameters<typeof routeAudiences>[0]['event'],
    teamHasSlackChannel: boolean,
    reviewerEmailEnabled: boolean
  ) => routeAudiences({ event, reviewerEmailEnabled, teamHasSlackChannel }).map((r) => r.audience);

  it('sends CREATED to the Slack channel when there is one', () => {
    expect(route('CREATED', true, true)).toEqual(['TEAM_CHANNEL']);
    expect(route('CREATED', true, false)).toEqual(['TEAM_CHANNEL']);
  });

  it('falls back to reviewer email only when enabled', () => {
    expect(route('CREATED', false, true)).toEqual(['TEAM_REVIEWERS']);
    expect(route('CREATED', false, false)).toEqual([]);
  });

  it('sends decisions to the requester, whatever the Slack and email settings', () => {
    for (const slack of [true, false]) {
      for (const email of [true, false]) {
        expect(route('APPROVED', slack, email)).toEqual(['REQUESTER']);
        expect(route('REJECTED', slack, email)).toEqual(['REQUESTER']);
        expect(route('PENDING_ORG', slack, email)).toEqual(['REQUESTER', 'ORG_ADMINS']);
      }
    }
  });

  it('pairs each audience with its channel', () => {
    expect(
      routeAudiences({ event: 'CREATED', reviewerEmailEnabled: true, teamHasSlackChannel: true })
    ).toEqual([{ audience: 'TEAM_CHANNEL', channel: 'SLACK' }]);
    expect(AUDIENCE_CHANNEL).toEqual({
      ORG_ADMINS: 'EMAIL',
      REQUESTER: 'EMAIL',
      TEAM_CHANNEL: 'SLACK',
      TEAM_REVIEWERS: 'EMAIL',
    });
  });
});

describe('recipients', () => {
  it('caps at 20 by default', () => {
    expect(MAX_NOTIFICATION_RECIPIENTS).toBe(20);
    const many = Array.from({ length: 30 }, (_, i) => `u${i}@example.com`);
    expect(capRecipients(many)).toHaveLength(20);
    expect(capRecipients(many)[0]).toBe('u0@example.com');
  });

  it('dedupes case-insensitively and drops blanks before capping', () => {
    expect(capRecipients(['A@x.com', 'a@X.com ', '', '  ', 'b@x.com'])).toEqual([
      'A@x.com',
      'b@x.com',
    ]);
    expect(capRecipients(['a@x.com', 'a@x.com', 'b@x.com', 'c@x.com'], 2)).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
  });
});

describe('mergeReached', () => {
  it('unions and dedupes, keeping order and the earlier spelling', () => {
    expect(mergeReached(['a@x.com', 'B@x.com'], ['b@x.com', 'c@x.com', 'a@x.com'])).toEqual([
      'a@x.com',
      'B@x.com',
      'c@x.com',
    ]);
  });

  it('treats a non-array or junk entries as empty', () => {
    expect(mergeReached(null, ['a@x.com'])).toEqual(['a@x.com']);
    expect(mergeReached({}, [])).toEqual([]);
    expect(mergeReached(['a@x.com', 3, null, ''], ['a@x.com'])).toEqual(['a@x.com']);
  });

  it('does not mutate its inputs', () => {
    const reached = ['a@x.com'];
    mergeReached(reached, ['b@x.com']);
    expect(reached).toEqual(['a@x.com']);
  });
});
