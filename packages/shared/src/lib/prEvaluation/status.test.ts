import { describe, expect, it } from 'vitest';
import { approvalState, hasHumanObjection, statusFor } from './status.js';
import type { ApprovalState, Classification, PrEvaluationMode, PrReview } from './types.js';

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

describe('approvalState: excludedIdentities', () => {
  const withId = (login: string, userId: string | null, state = 'APPROVED'): PrReview => ({
    commitId: HEAD,
    login,
    state,
    userId,
  });
  const none = { ids: new Set<string>(), logins: new Set<string>() };

  it('excludes a review by the launcher id, and counts a second human', () => {
    const reviews = [withId('launcher', '42'), withId('bob', '7')];
    const state = approvalState(reviews, 'z', 1, HEAD, [], undefined, {
      ids: new Set(['42']),
      logins: new Set(),
    });
    expect(state).toEqual({ approvers: ['bob'], required: 1, satisfied: true });
  });

  it('excludes by login, case-insensitively, when the review carries no id', () => {
    const reviews = [review('LauNcher', 'APPROVED'), review('bob', 'APPROVED')];
    const state = approvalState(reviews, 'z', 1, HEAD, [], undefined, {
      ids: new Set(),
      logins: new Set(['launcher']),
    });
    expect(state.approvers).toEqual(['bob']);
  });

  it('excludes by id even when the login differs after a rename', () => {
    const reviews = [withId('renamed-launcher', '42')];
    const state = approvalState(reviews, 'z', 1, HEAD, [], undefined, {
      ids: new Set(['42']),
      logins: new Set(['old-name']),
    });
    expect(state.approvers).toEqual([]);
    expect(state.satisfied).toBe(false);
  });

  it('excludes nothing when both sets are empty or the option is absent', () => {
    const reviews = [withId('a', '1'), withId('b', null)];
    expect(approvalState(reviews, 'z', 2, HEAD, [], undefined, none).approvers).toEqual(['a', 'b']);
    expect(approvalState(reviews, 'z', 2, HEAD).approvers).toEqual(['a', 'b']);
  });

  it('does not reduce the required count', () => {
    const state = approvalState([withId('launcher', '42')], 'z', 2, HEAD, [], undefined, {
      ids: new Set(['42']),
      logins: new Set(),
    });
    expect(state).toEqual({ approvers: [], required: 2, satisfied: false });
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

  it.each([
    ['auto', /^HIGH risk/],
    ['enforce', /^enforce: HIGH risk/],
    ['mystery', /^HIGH risk/],
  ])('holds %s to pending-until-approved, success once satisfied', (mode, label) => {
    const pending = statusFor(cls({ riskClass: 'HIGH' }), none, mode as PrEvaluationMode);
    expect(pending?.state).toBe('pending');
    expect(pending?.description).toMatch(label);
    expect(statusFor(cls(), ok, mode as PrEvaluationMode)?.state).toBe('success');
  });

  it.each(['auto', 'enforce', 'mystery'])('fails %s when the evaluation errored', (mode) => {
    const errored = cls({
      reasons: [{ code: 'evaluation-error', message: 'boom', severity: 'exclusion' }],
      riskClass: 'HIGH',
    });
    expect(statusFor(errored, ok, mode as PrEvaluationMode)?.state).toBe('failure');
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
    for (const mode of ['advisory', 'auto', 'enforce'] as const) {
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

describe('statusFor: evaluatorApproved', () => {
  const none: ApprovalState = { approvers: [], required: 1, satisfied: false };
  const low = cls({ autoEligible: true, requiredApprovers: 1, riskClass: 'LOW' });

  it('is a success for a LOW change in a mode that holds the status, with a fixed description', () => {
    for (const mode of ['enforce', 'auto'] as const) {
      const status = statusFor(low, none, mode, { evaluatorApproved: true });
      expect(status?.state).toBe('success');
      expect(status?.description).toBe(
        mode === 'enforce'
          ? 'enforce: LOW risk: approved by the evaluator, no human approval required'
          : 'LOW risk: approved by the evaluator, no human approval required'
      );
      expect((status?.description ?? '').length).toBeLessThanOrEqual(140);
    }
  });

  it.each(['STANDARD', 'HIGH'] as const)('is ignored for the %s class', (riskClass) => {
    for (const mode of ['enforce', 'auto'] as const) {
      const c = cls({ riskClass });
      expect(statusFor(c, none, mode, { evaluatorApproved: true })).toEqual(
        statusFor(c, none, mode)
      );
      expect(statusFor(c, none, mode, { evaluatorApproved: true })?.state).toBe('pending');
    }
  });

  it('is ignored in advisory and off', () => {
    expect(statusFor(low, none, 'advisory', { evaluatorApproved: true })).toEqual(
      statusFor(low, none, 'advisory')
    );
    expect(statusFor(low, none, 'off', { evaluatorApproved: true })).toBeNull();
  });

  it('is ignored when false, undefined or not strictly true', () => {
    for (const flag of [false, undefined, 'true' as unknown as boolean, 1 as unknown as boolean]) {
      expect(statusFor(low, none, 'auto', { evaluatorApproved: flag })).toEqual(
        statusFor(low, none, 'auto')
      );
    }
    expect(statusFor(low, none, 'auto', {})).toEqual(statusFor(low, none, 'auto'));
  });

  it('cannot override an evaluation error', () => {
    const errored = cls({
      reasons: [{ code: 'evaluation-error', message: 'x', severity: 'raise' }],
      riskClass: 'LOW',
    });
    for (const mode of ['enforce', 'auto'] as const) {
      expect(statusFor(errored, none, mode, { evaluatorApproved: true })?.state).toBe('failure');
    }
  });

  it('leaves an already satisfied approval count as it was', () => {
    const ok: ApprovalState = { approvers: ['a'], required: 1, satisfied: true };
    expect(statusFor(cls({ riskClass: 'HIGH' }), ok, 'auto', { evaluatorApproved: true })).toEqual(
      statusFor(cls({ riskClass: 'HIGH' }), ok, 'auto')
    );
  });
});

describe('approvalState: bot reviews', () => {
  it('never counts an APPROVED review by an App account, even one named in the eligible set', () => {
    const reviews = [review('approver-app[bot]', 'APPROVED')];
    expect(approvalState(reviews, 'platform-app[bot]', 1, HEAD).approvers).toEqual([]);
    expect(
      approvalState(reviews, 'platform-app[bot]', 1, HEAD, [], new Set(['approver-app[bot]']))
        .satisfied
    ).toBe(false);
  });
});

describe('hasHumanObjection', () => {
  const object = (login: string) => review(login, 'CHANGES_REQUESTED');
  it('is true for a standing request for changes on any commit', () => {
    expect(hasHumanObjection([object('bob')], 'alice')).toBe(true);
    expect(hasHumanObjection([review('bob', 'CHANGES_REQUESTED', 'old')], 'alice')).toBe(true);
  });
  it('is false once the same person approves, or the request was dismissed', () => {
    expect(hasHumanObjection([object('bob'), review('Bob', 'APPROVED')], 'alice')).toBe(false);
    expect(hasHumanObjection([object('bob'), review('bob', 'DISMISSED')], 'alice')).toBe(false);
  });
  it('keeps a request standing past a later plain comment, as the host does', () => {
    expect(hasHumanObjection([object('bob'), review('bob', 'COMMENTED')], 'alice')).toBe(true);
  });
  it('lets a later request override an earlier approval, per login', () => {
    expect(hasHumanObjection([review('bob', 'APPROVED'), object('BOB')], 'alice')).toBe(true);
  });
  it('ignores the author and any bot account', () => {
    expect(hasHumanObjection([object('Alice')], 'alice')).toBe(false);
    expect(hasHumanObjection([object('review-bot[bot]')], 'alice')).toBe(false);
  });
  it('is false for no reviews and for approvals only', () => {
    expect(hasHumanObjection([], 'alice')).toBe(false);
    expect(hasHumanObjection([review('bob', 'APPROVED')], 'alice')).toBe(false);
  });
});
