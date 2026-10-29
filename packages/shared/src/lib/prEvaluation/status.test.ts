import { describe, expect, it } from 'vitest';
import { approvalState, statusFor } from './status.js';
import type { Classification, PrReview } from './types.js';

const HEAD = 'abc123';
const review = (login: string, state: string, commitId = HEAD): PrReview => ({
  commitId,
  login,
  state,
});
const cls = (overrides: Partial<Classification> = {}): Classification => ({
  autoEligible: false,
  reasons: [],
  requiredApprovers: 1,
  riskClass: 'STANDARD',
  ...overrides,
});

describe('approvalState: eligibleLogins', () => {
  const reviews = [review('Alice', 'APPROVED'), review('bob', 'APPROVED')];

  it('counts only logins in the eligible set, case-insensitively', () => {
    const state = approvalState(reviews, 'z', 1, HEAD, [], new Set(['alice']));
    expect(state).toEqual({ approvers: ['Alice'], required: 1, satisfied: true });
    expect(approvalState(reviews, 'z', 2, HEAD, [], new Set(['alice'])).satisfied).toBe(false);
  });

  it('counts nobody when the eligible set is empty', () => {
    expect(approvalState(reviews, 'z', 1, HEAD, [], new Set()).approvers).toEqual([]);
  });

  it('is unchanged when the set is omitted', () => {
    expect(approvalState(reviews, 'z', 2, HEAD).approvers).toEqual(['Alice', 'bob']);
  });
});

describe('approvalState', () => {
  it('counts distinct approvers on the head commit', () => {
    const state = approvalState([review('a', 'APPROVED'), review('b', 'APPROVED')], 'z', 2, HEAD);
    expect(state).toEqual({ approvers: ['a', 'b'], required: 2, satisfied: true });
  });

  it('counts only the latest review per login, case-insensitively', () => {
    const state = approvalState(
      [review('Alice', 'APPROVED'), review('alice', 'CHANGES_REQUESTED')],
      'z',
      1,
      HEAD
    );
    expect(state.approvers).toEqual([]);
    expect(state.satisfied).toBe(false);
    const later = approvalState(
      [review('alice', 'CHANGES_REQUESTED'), review('ALICE', 'APPROVED')],
      'z',
      1,
      HEAD
    );
    expect(later.approvers).toEqual(['ALICE']);
  });

  it('withdraws an approval when the latest review is a comment', () => {
    expect(
      approvalState([review('a', 'APPROVED'), review('a', 'COMMENTED')], 'z', 1, HEAD).satisfied
    ).toBe(false);
  });

  it('ignores the author in any case', () => {
    const state = approvalState([review('Author', 'APPROVED')], 'author', 1, HEAD);
    expect(state.approvers).toEqual([]);
  });

  it('ignores non-approvals and reviews of another commit', () => {
    const state = approvalState(
      [review('a', 'DISMISSED'), review('b', 'COMMENTED'), review('c', 'APPROVED', 'old')],
      'z',
      1,
      HEAD
    );
    expect(state.approvers).toEqual([]);
  });
});

describe('statusFor', () => {
  const none = { approvers: [], required: 1, satisfied: false };
  const ok = { approvers: ['a'], required: 1, satisfied: true };

  it('is null when off', () => {
    expect(statusFor(cls(), none, 'off')).toBeNull();
  });

  it('is always success in advisory, and says so', () => {
    const status = statusFor(cls({ riskClass: 'HIGH' }), none, 'advisory');
    expect(status?.state).toBe('success');
    expect(status?.description).toMatch(/advisory/);
    expect(status?.description).toMatch(/HIGH/);
  });

  it('is pending until approvals are satisfied in auto', () => {
    expect(statusFor(cls(), none, 'auto')?.state).toBe('pending');
    expect(statusFor(cls(), ok, 'auto')?.state).toBe('success');
  });

  it('fails when the evaluation errored', () => {
    const errored = cls({
      reasons: [{ code: 'evaluation-error', message: 'boom', severity: 'exclusion' }],
      riskClass: 'HIGH',
    });
    expect(statusFor(errored, ok, 'auto')?.state).toBe('failure');
  });

  it('keeps the description within 140 characters', () => {
    const huge = {
      approvers: Array.from({ length: 5 }, () => 'x'),
      required: 10 ** 150,
      satisfied: false,
    };
    for (const mode of ['advisory', 'auto'] as const) {
      expect(statusFor(cls(), huge, mode)?.description.length).toBeLessThanOrEqual(140);
    }
  });
});

describe('approvalState hardening regressions', () => {
  it('ignores bot logins and explicitly ignored logins (finding 7)', () => {
    const reviews = [
      review('dependabot[bot]', 'APPROVED'),
      review('Github-Actions[BOT]', 'APPROVED'),
      review('carol', 'APPROVED'),
      review('dave', 'APPROVED'),
    ];
    expect(approvalState(reviews, 'alice', 1, HEAD).approvers).toEqual(['carol', 'dave']);
    expect(approvalState(reviews, 'alice', 1, HEAD, ['carol']).approvers).toEqual(['dave']);
  });

  it('never requires fewer than one approval (finding 8)', () => {
    for (const bad of [0, -3, Number.NaN, Number.NEGATIVE_INFINITY, 0.4]) {
      const state = approvalState([], 'alice', bad, HEAD);
      expect(state.required, String(bad)).toBe(1);
      expect(state.satisfied).toBe(false);
    }
    expect(approvalState([review('bob', 'APPROVED')], 'alice', 2.9, HEAD).required).toBe(2);
  });

  it('is unsatisfied with a blank head sha even if reviews carry a blank commit (finding 8)', () => {
    for (const sha of ['', '   ']) {
      const state = approvalState([review('bob', 'APPROVED', sha)], 'alice', 1, sha);
      expect(state).toMatchObject({ approvers: [], satisfied: false });
    }
  });
});
