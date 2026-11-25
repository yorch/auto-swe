import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  approvalCompletesOrgStep,
  approvalRoleOptions,
  buildApproveBody,
  buildCreateBody,
  buildDecisionBody,
  createTeamError,
  decisionErrorMessage,
  decisionNote,
  deriveSlug,
  directoryAction,
  directoryOrgOptions,
  isOpenJoinRequest,
  isValidSlug,
  joinCloseReasonText,
  joinRequestErrorMessage,
  joinRequestErrorStalesDirectory,
  joinStatusLabel,
  joinStatusTone,
  lengthState,
  mergeOrgOptions,
  requesterLabel,
  retryIn,
} from './joinRequests';

const NOW = new Date('2026-11-20T12:00:00Z');
const api = (status: number, code: string | null, details?: unknown) =>
  new ApiError('server words', status, code, details);

describe('status words', () => {
  it.each([
    ['PENDING_TEAM', 'Pending team approval', 'warning'],
    ['PENDING_ORG', 'Pending organization approval', 'info'],
    ['APPROVED', 'Approved', 'success'],
    ['REJECTED', 'Rejected', 'danger'],
    ['WITHDRAWN', 'Withdrawn', 'neutral'],
  ])('%s reads %s (%s)', (status, label, tone) => {
    expect(joinStatusLabel(status)).toBe(label);
    expect(joinStatusTone(status)).toBe(tone);
  });

  it('shows an unknown status as itself', () => {
    expect(joinStatusLabel('ARCHIVED')).toBe('ARCHIVED');
    expect(joinStatusTone('ARCHIVED')).toBe('neutral');
  });

  it('allows withdrawal only while open', () => {
    expect(isOpenJoinRequest('PENDING_TEAM')).toBe(true);
    expect(isOpenJoinRequest('PENDING_ORG')).toBe(true);
    for (const s of ['APPROVED', 'REJECTED', 'WITHDRAWN']) {
      expect(isOpenJoinRequest(s)).toBe(false);
    }
  });
});

describe('decisionNote', () => {
  it('prefers the organization note, then the team note, then none', () => {
    expect(decisionNote({ orgDecisionNote: 'org', teamDecisionNote: 'team' })).toEqual({
      by: 'organization',
      note: 'org',
    });
    expect(decisionNote({ orgDecisionNote: '  ', teamDecisionNote: 'team' })).toEqual({
      by: 'team',
      note: 'team',
    });
    expect(decisionNote({ orgDecisionNote: null, teamDecisionNote: null })).toBeNull();
  });
});

describe('requesterLabel', () => {
  it('uses the name, else the email, else a placeholder', () => {
    expect(requesterLabel({ requester: { email: 'a@x.io', name: 'Ada' } })).toBe('Ada');
    expect(requesterLabel({ requester: { email: 'a@x.io', name: ' ' } })).toBe('a@x.io');
    expect(requesterLabel({ user: { email: 'u@x.io' } })).toBe('u@x.io');
    expect(requesterLabel({})).toBe('Unknown user');
  });
});

describe('directoryAction', () => {
  it('offers a request only to someone with no tie to the team', () => {
    expect(directoryAction('NONE')).toEqual({ badge: null, canOpen: false, canRequest: true });
    expect(directoryAction('MEMBER')).toEqual({
      badge: 'Member',
      canOpen: true,
      canRequest: false,
    });
    expect(directoryAction('REQUESTED')).toEqual({
      badge: 'Requested',
      canOpen: false,
      canRequest: false,
    });
  });

  it('opens the team instead of offering a request to someone who governs it', () => {
    expect(directoryAction('GOVERNS')).toEqual({
      badge: 'Administered',
      canOpen: true,
      canRequest: false,
    });
  });
});

describe('lengthState and bodies', () => {
  it('counts characters and flags overflow', () => {
    expect(lengthState('abc', 5)).toEqual({ count: 3, over: false, remaining: 2 });
    expect(lengthState('abcdef', 5)).toEqual({ count: 6, over: true, remaining: -1 });
    expect(lengthState('a'.repeat(500), 500).over).toBe(false);
  });

  it('trims the request message and always sends it', () => {
    expect(buildCreateBody('  hello  ')).toEqual({ message: 'hello' });
    expect(buildCreateBody('')).toEqual({ message: '' });
  });

  it('builds a decision body with a note only when there is one', () => {
    expect(buildDecisionBody('  ')).toEqual({});
    expect(buildDecisionBody(' no thanks ')).toEqual({ note: 'no thanks' });
  });
});

describe('role ceiling', () => {
  it('offers the grantable roles lowest first, deduplicated, never anything else', () => {
    expect(approvalRoleOptions(['LEAD', 'MEMBER'])).toEqual(['MEMBER', 'LEAD']);
    expect(approvalRoleOptions(['MEMBER', 'MEMBER'])).toEqual(['MEMBER']);
    expect(approvalRoleOptions(['OWNER' as never, 'ADMIN', 'LEAD', 'MEMBER'])).toEqual([
      'MEMBER',
      'LEAD',
      'ADMIN',
    ]);
    expect(approvalRoleOptions([])).toEqual([]);
  });

  it('omits the default role and any role the approver may not grant', () => {
    const allowed = ['MEMBER', 'LEAD'] as const;
    expect(buildApproveBody({ allowed, note: '', role: 'MEMBER' })).toEqual({});
    expect(buildApproveBody({ allowed, note: '', role: '' })).toEqual({});
    expect(buildApproveBody({ allowed, note: ' ok ', role: 'LEAD' })).toEqual({
      note: 'ok',
      role: 'LEAD',
    });
    expect(buildApproveBody({ allowed, note: '', role: 'ADMIN' })).toEqual({});
  });
});

describe('slug', () => {
  it.each([
    ['Payments Platform', 'payments-platform'],
    ['  --Weird__Name!!  ', 'weird-name'],
    ['Équipe 42', 'quipe-42'],
    ['!!!', ''],
    ['a'.repeat(60), 'a'.repeat(50)],
  ])('derives %j as %j', (name, slug) => {
    expect(deriveSlug(name)).toBe(slug);
  });

  it('never ends the cut slug on a hyphen', () => {
    const slug = deriveSlug(`${'a'.repeat(49)} b`);
    expect(slug.endsWith('-')).toBe(false);
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each([
    ['payments', true],
    ['payments-platform-2', true],
    ['', false],
    ['Payments', false],
    ['-lead', false],
    ['trail-', false],
    ['double--hyphen', false],
    ['under_score', false],
    ['a'.repeat(51), false],
  ])('validates %j as %s', (slug, ok) => {
    expect(isValidSlug(slug)).toBe(ok);
  });
});

describe('retryIn', () => {
  it.each([
    [30, 'in 1 minute'],
    [20 * 60, 'in 20 minutes'],
    [3 * 3600, 'in about 3 hours'],
    [72 * 3600, 'in about 3 days'],
  ])('%d seconds ahead reads %s', (seconds, text) => {
    expect(retryIn(new Date(NOW.getTime() + seconds * 1000), NOW)).toBe(text);
  });

  it('is null once the time has passed', () => {
    expect(retryIn(NOW, NOW)).toBeNull();
    expect(retryIn(new Date(NOW.getTime() - 1000), NOW)).toBeNull();
  });
});

describe('joinRequestErrorMessage', () => {
  it('words each refusal in the contract', () => {
    expect(joinRequestErrorMessage(api(409, 'ALREADY_MEMBER'), NOW)).toMatch(/already a member/);
    expect(joinRequestErrorMessage(api(409, 'REQUEST_PENDING'), NOW)).toMatch(/open request/);
    expect(joinRequestErrorMessage(api(429, 'TOO_MANY_OPEN_REQUESTS'), NOW)).toMatch(
      /too many open requests/
    );
    expect(joinRequestErrorMessage(api(404, 'TEAM_NOT_FOUND'), NOW)).toMatch(/no longer available/);
    expect(joinRequestErrorMessage(api(404, null), NOW)).toMatch(/no longer available/);
  });

  it('gives the retry time of a cooldown from retryAfterSeconds or retryAt', () => {
    expect(
      joinRequestErrorMessage(api(429, 'JOIN_REQUEST_COOLDOWN', { retryAfterSeconds: 7200 }), NOW)
    ).toContain('in about 2 hours');
    expect(
      joinRequestErrorMessage(
        api(429, 'JOIN_REQUEST_COOLDOWN', { retryAt: '2026-11-20T12:30:00Z' }),
        NOW
      )
    ).toContain('in 30 minutes');
  });

  it('words the cooldown by why it started', () => {
    const d = { retryAfterSeconds: 7200 };
    expect(
      joinRequestErrorMessage(api(429, 'JOIN_REQUEST_COOLDOWN', { ...d, reason: 'withdrawn' }), NOW)
    ).toBe('You withdrew a request to this team recently. You can ask again in about 2 hours.');
    expect(
      joinRequestErrorMessage(api(429, 'JOIN_REQUEST_COOLDOWN', { ...d, reason: 'rejected' }), NOW)
    ).toBe('A recent request to this team was rejected. You can ask again in about 2 hours.');
    expect(
      joinRequestErrorMessage(api(429, 'JOIN_REQUEST_COOLDOWN', { reason: 'withdrawn' }), NOW)
    ).toBe('You withdrew a request to this team recently. Try again later.');
  });

  it('falls back when a cooldown names no usable time', () => {
    for (const details of [undefined, {}, { retryAt: 'nonsense' }, { retryAfterSeconds: -5 }]) {
      expect(joinRequestErrorMessage(api(429, 'JOIN_REQUEST_COOLDOWN', details), NOW)).toMatch(
        /Try again later/
      );
    }
  });

  it('passes other errors through', () => {
    expect(joinRequestErrorMessage(new Error('boom'), NOW)).toBe('boom');
    expect(joinRequestErrorMessage('x', NOW)).toBe('Could not send the request');
    expect(joinRequestErrorMessage(api(500, 'INTERNAL'), NOW)).toBe('server words');
  });

  it('marks the refusals that mean the directory row is stale', () => {
    expect(joinRequestErrorStalesDirectory(api(409, 'ALREADY_MEMBER'))).toBe(true);
    expect(joinRequestErrorStalesDirectory(api(409, 'REQUEST_PENDING'))).toBe(true);
    expect(joinRequestErrorStalesDirectory(api(404, null))).toBe(true);
    expect(joinRequestErrorStalesDirectory(api(429, 'JOIN_REQUEST_COOLDOWN'))).toBe(false);
    expect(joinRequestErrorStalesDirectory(new Error('x'))).toBe(false);
  });
});

describe('decisionErrorMessage', () => {
  it('words not-found, forbidden and unknown refusals', () => {
    expect(decisionErrorMessage(api(404, null), 'f')).toMatch(/no longer exists/);
    expect(decisionErrorMessage(api(403, null), 'f')).toMatch(/permission/);
    expect(decisionErrorMessage(api(409, 'SOMETHING_NEW'), 'f')).toBe('server words');
    expect(decisionErrorMessage(new Error('boom'), 'f')).toBe('boom');
    expect(decisionErrorMessage(null, 'fallback')).toBe('fallback');
  });

  it.each([
    [409, 'REQUEST_ALREADY_DECIDED', /already decided or withdrawn.*refreshed/],
    [409, 'REQUEST_NOT_OPEN', /already decided or withdrawn.*refreshed/],
    [409, 'REQUESTER_INACTIVE', /account is deactivated; reject this request/],
    [409, 'TEAM_INACTIVE', /team is deactivated/],
    [409, 'ALREADY_MEMBER', /already a member/],
    [403, 'PRIVILEGE_ESCALATION', /above your own/],
    [403, 'SELF_DECISION', /your own request/],
  ])('words %i %s by its code', (status, code, text) => {
    expect(decisionErrorMessage(api(status, code), 'f')).toMatch(text);
  });
});

describe('createTeamError', () => {
  it('words the limit and conflicts, attributing a field where the code does', () => {
    expect(createTeamError(api(409, 'TEAM_LIMIT_REACHED')).message).toMatch(/limit of teams/);
    expect(createTeamError(api(409, 'TEAM_EXISTS'))).toMatchObject({ field: null });
    expect(createTeamError(api(409, 'NAME_TAKEN')).field).toBe('name');
    expect(createTeamError(api(409, 'SLUG_TAKEN')).field).toBe('slug');
    expect(createTeamError(api(403, null)).message).toMatch(/may not create/);
    expect(createTeamError(new Error('x'))).toEqual({ field: null, message: 'x' });
  });
});

describe('mergeOrgOptions', () => {
  it('accumulates organizations across pages and filters, sorted by name', () => {
    const first = mergeOrgOptions(
      [],
      [
        { orgId: 'o2', orgName: 'Zeta' },
        { orgId: 'o1', orgName: 'Acme' },
      ]
    );
    expect(first.map((o) => o.name)).toEqual(['Acme', 'Zeta']);
    // A filtered page shows only one organization; the others stay offered.
    const second = mergeOrgOptions(first, [{ orgId: 'o2', orgName: 'Zeta' }]);
    expect(second).toHaveLength(2);
    expect(mergeOrgOptions(second, [{ orgId: 'o3', orgName: 'Mid' }]).map((o) => o.id)).toEqual([
      'o1',
      'o3',
      'o2',
    ]);
  });
});

describe('closeReason', () => {
  it('words each system close and says nothing for a decision by a person', () => {
    expect(joinCloseReasonText('TEAM_DEACTIVATED')).toBe(
      'Closed automatically: the team was deactivated'
    );
    expect(joinCloseReasonText('ORGANIZATION_DEACTIVATED')).toBe(
      'Closed automatically: the organization was deactivated'
    );
    expect(joinCloseReasonText('REQUESTER_DEACTIVATED')).toBe(
      'Closed automatically: the requester account was deactivated'
    );
    expect(joinCloseReasonText('SOMETHING_NEW')).toBe('Closed automatically');
    expect(joinCloseReasonText(null)).toBeNull();
    expect(joinCloseReasonText(undefined)).toBeNull();
  });

  it('labels a system close in words, keeping the status for a decision by a person', () => {
    expect(joinStatusLabel('REJECTED', 'TEAM_DEACTIVATED')).toBe('Closed automatically');
    expect(joinStatusLabel('WITHDRAWN', 'REQUESTER_DEACTIVATED')).toBe('Closed automatically');
    expect(joinStatusLabel('REJECTED', null)).toBe('Rejected');
    expect(joinStatusLabel('REJECTED')).toBe('Rejected');
    expect(joinStatusLabel('PENDING_TEAM', 'TEAM_DEACTIVATED')).toBe('Pending team approval');
  });
});

describe('directoryOrgOptions', () => {
  const listed = [
    { id: 'o2', name: 'Zeta' },
    { id: 'o1', name: 'Acme' },
  ];
  it('uses the gateway list, sorted, whatever pages were seen', () => {
    expect(directoryOrgOptions({ creatable: [], known: [{ id: 'x', name: 'X' }], listed })).toEqual(
      [
        { id: 'o1', name: 'Acme' },
        { id: 'o2', name: 'Zeta' },
      ]
    );
  });
  it('falls back to the organizations seen when the gateway sent none', () => {
    expect(
      directoryOrgOptions({
        creatable: [{ id: 'o3', name: 'Mid' }],
        known: [{ id: 'o1', name: 'Acme' }],
        listed: undefined,
      }).map((o) => o.id)
    ).toEqual(['o1', 'o3']);
  });
});

describe('approvalCompletesOrgStep', () => {
  it('needs a cross-organization request with an organization and the viewer managing it', () => {
    const row = { orgId: 'o1', requiresOrgApproval: true };
    expect(approvalCompletesOrgStep(row, true)).toBe(true);
    expect(approvalCompletesOrgStep(row, false)).toBe(false);
    expect(approvalCompletesOrgStep({ orgId: 'o1', requiresOrgApproval: false }, true)).toBe(false);
    expect(approvalCompletesOrgStep({ orgId: null, requiresOrgApproval: true }, true)).toBe(false);
    expect(approvalCompletesOrgStep(null, true)).toBe(false);
  });
});
