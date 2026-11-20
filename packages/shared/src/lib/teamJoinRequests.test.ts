import { describe, expect, it } from 'vitest';
import { JoinRequestStatus } from '../generated/prisma/enums.js';
import {
  approveJoinRequestBodySchema,
  canTransition,
  createJoinRequestBodySchema,
  decideJoinRequestBodySchema,
  evaluateCooldown,
  evaluateOpenCap,
  FINAL_JOIN_REQUEST_STATUSES,
  isOpenStatus,
  JOIN_REQUEST_STATUSES,
  JOIN_REQUEST_TRANSITIONS,
  MAX_JOIN_REQUEST_MESSAGE_LENGTH,
  OPEN_JOIN_REQUEST_STATUSES,
  resolveGrantedRole,
  statusAfterTeamApproval,
} from './teamJoinRequests.js';

describe('status vocabulary', () => {
  it('matches the Prisma enum', () => {
    expect([...JOIN_REQUEST_STATUSES].sort()).toEqual(Object.values(JoinRequestStatus).sort());
  });

  it('splits into open and final with nothing left over', () => {
    expect([...OPEN_JOIN_REQUEST_STATUSES, ...FINAL_JOIN_REQUEST_STATUSES].sort()).toEqual(
      [...JOIN_REQUEST_STATUSES].sort()
    );
  });
});

describe('canTransition', () => {
  it('allows the transitions of the contract', () => {
    expect(canTransition('PENDING_TEAM', 'APPROVED')).toBe(true);
    expect(canTransition('PENDING_TEAM', 'PENDING_ORG')).toBe(true);
    expect(canTransition('PENDING_TEAM', 'REJECTED')).toBe(true);
    expect(canTransition('PENDING_TEAM', 'WITHDRAWN')).toBe(true);
    expect(canTransition('PENDING_ORG', 'APPROVED')).toBe(true);
    expect(canTransition('PENDING_ORG', 'REJECTED')).toBe(true);
    expect(canTransition('PENDING_ORG', 'WITHDRAWN')).toBe(true);
  });

  it('never goes back to the team step or to itself', () => {
    expect(canTransition('PENDING_ORG', 'PENDING_TEAM')).toBe(false);
    for (const status of JOIN_REQUEST_STATUSES) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });

  it('leaves a final status where it is', () => {
    for (const from of FINAL_JOIN_REQUEST_STATUSES) {
      expect(JOIN_REQUEST_TRANSITIONS[from], from).toEqual([]);
      for (const to of JOIN_REQUEST_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });
});

describe('isOpenStatus', () => {
  it('is true for exactly the two pending statuses', () => {
    expect(JOIN_REQUEST_STATUSES.filter(isOpenStatus)).toEqual(['PENDING_TEAM', 'PENDING_ORG']);
  });
});

describe('statusAfterTeamApproval', () => {
  it('completes a same-organization request and escalates a cross-organization one', () => {
    expect(statusAfterTeamApproval(false)).toBe('APPROVED');
    expect(statusAfterTeamApproval(true)).toBe('PENDING_ORG');
  });
});

describe('evaluateCooldown', () => {
  const now = new Date('2026-11-20T12:00:00Z');

  it('does not block when nothing was rejected', () => {
    expect(evaluateCooldown({ cooldownHours: 72, lastRejectedAt: null, now })).toEqual({
      blocked: false,
    });
  });

  it('does not block when the cooldown is 0', () => {
    expect(evaluateCooldown({ cooldownHours: 0, lastRejectedAt: now, now })).toEqual({
      blocked: false,
    });
  });

  it('blocks inside the window and says when to retry', () => {
    const result = evaluateCooldown({
      cooldownHours: 72,
      lastRejectedAt: new Date('2026-11-18T12:00:00Z'),
      now,
    });
    expect(result).toEqual({
      blocked: true,
      retryAfterSeconds: 24 * 3600,
      retryAt: new Date('2026-11-21T12:00:00Z'),
    });
  });

  it('rounds the wait up to a whole second', () => {
    const result = evaluateCooldown({
      cooldownHours: 1,
      lastRejectedAt: new Date(now.getTime() - 3_600_000 + 1),
      now,
    });
    expect(result).toMatchObject({ blocked: true, retryAfterSeconds: 1 });
  });

  it('allows a request exactly at, and after, the end of the window', () => {
    const at = new Date('2026-11-17T12:00:00Z');
    expect(evaluateCooldown({ cooldownHours: 72, lastRejectedAt: at, now })).toEqual({
      blocked: false,
    });
    expect(
      evaluateCooldown({ cooldownHours: 72, lastRejectedAt: new Date('2026-11-01T00:00:00Z'), now })
    ).toEqual({ blocked: false });
  });
});

describe('evaluateOpenCap', () => {
  it('blocks at and above the cap', () => {
    expect(evaluateOpenCap({ maxOpen: 5, openCount: 4 })).toEqual({ blocked: false, remaining: 1 });
    expect(evaluateOpenCap({ maxOpen: 5, openCount: 5 })).toEqual({ blocked: true, remaining: 0 });
    expect(evaluateOpenCap({ maxOpen: 5, openCount: 9 })).toEqual({ blocked: true, remaining: 0 });
  });
});

describe('resolveGrantedRole', () => {
  it('defaults to MEMBER', () => {
    expect(resolveGrantedRole(undefined)).toBe('MEMBER');
    expect(resolveGrantedRole(null)).toBe('MEMBER');
    expect(resolveGrantedRole('LEAD')).toBe('LEAD');
  });
});

describe('body schemas', () => {
  it('defaults and trims the message and caps it at the limit', () => {
    expect(createJoinRequestBodySchema.parse({})).toEqual({ message: '' });
    expect(createJoinRequestBodySchema.parse({ message: '  hi  ' })).toEqual({ message: 'hi' });
    const max = 'x'.repeat(MAX_JOIN_REQUEST_MESSAGE_LENGTH);
    expect(createJoinRequestBodySchema.safeParse({ message: max }).success).toBe(true);
    expect(createJoinRequestBodySchema.safeParse({ message: `${max}x` }).success).toBe(false);
  });

  it('accepts a team role on approval and nothing else', () => {
    expect(approveJoinRequestBodySchema.parse({})).toEqual({});
    expect(approveJoinRequestBodySchema.parse({ note: 'welcome', role: 'LEAD' })).toEqual({
      note: 'welcome',
      role: 'LEAD',
    });
    expect(approveJoinRequestBodySchema.safeParse({ role: 'ORG_ADMIN' }).success).toBe(false);
    expect(approveJoinRequestBodySchema.safeParse({ role: 'USER' }).success).toBe(false);
  });

  it('bounds a decision note', () => {
    expect(decideJoinRequestBodySchema.parse({})).toEqual({});
    expect(decideJoinRequestBodySchema.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
  });
});
