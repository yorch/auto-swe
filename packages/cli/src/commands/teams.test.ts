import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTeamsCommand } from './teams.js';

const ENV = { apiUrl: 'http://gw', token: 't' };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function respond(status: number, data: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    text: async () => JSON.stringify(ok ? { data } : data),
  } as unknown as Response;
}

function respondWithMeta(data: unknown, meta: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data, meta }),
  } as unknown as Response;
}

describe('runTeamsCommand', () => {
  let stderrWrites: string[];
  let stdoutWrites: string[];
  let originalErr: typeof process.stderr.write;
  let originalOut: typeof process.stdout.write;
  let originalFetch: typeof globalThis.fetch;
  let calls: Call[];
  let nextResponse: Response;

  beforeEach(() => {
    stderrWrites = [];
    stdoutWrites = [];
    calls = [];
    originalErr = process.stderr.write;
    originalOut = process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((s: string | Uint8Array) => {
      stdoutWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stdout.write;
    originalFetch = globalThis.fetch;
    nextResponse = respond(200, []);
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method: String(init?.method),
        url: String(url),
      });
      return nextResponse;
    }) as typeof fetch;
  });

  afterEach(() => {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
    globalThis.fetch = originalFetch;
  });

  const out = () => stdoutWrites.join('');
  const err = () => stderrWrites.join('');

  describe('directory', () => {
    it('lists the teams with relationship and memberships as a table', async () => {
      nextResponse = respond(200, {
        creatableOrgs: [],
        nextCursor: null,
        scope: 'platform',
        teams: [
          {
            description: null,
            id: 'team-1',
            memberCount: 4,
            name: 'Payments',
            orgId: 'org-1',
            orgName: 'Acme',
            relationship: 'NONE',
            requestId: null,
            slug: 'payments',
          },
          {
            description: null,
            id: 'team-2',
            memberCount: 9,
            name: 'Platform',
            orgId: 'org-1',
            orgName: 'Acme',
            relationship: 'REQUESTED',
            requestId: 'req-7',
            slug: 'platform',
          },
        ],
      });
      const code = await runTeamsCommand(['directory'], ENV);
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: undefined,
        method: 'GET',
        url: 'http://gw/api/v1/teams/directory',
      });
      expect(out()).toContain('Payments');
      expect(out()).toContain('requested (req-7)');
      expect(out()).toContain('none');
    });

    it('sends query, org and limit as query parameters', async () => {
      await runTeamsCommand(['directory', '--query=pay ments', '--org=org-1', '--limit=5'], ENV);
      expect(calls[0]?.url).toBe(
        'http://gw/api/v1/teams/directory?q=pay+ments&orgId=org-1&limit=5'
      );
    });

    it('prints the whole page as JSON with --json', async () => {
      nextResponse = respond(200, {
        creatableOrgs: [],
        nextCursor: null,
        scope: 'organization',
        teams: [],
      });
      const code = await runTeamsCommand(['directory', '--json'], ENV);
      expect(code).toBe(0);
      expect(JSON.parse(out())).toMatchObject({ scope: 'organization', teams: [] });
    });

    it('prints the next cursor when there is another page', async () => {
      nextResponse = respond(200, {
        creatableOrgs: [],
        nextCursor: 'abc',
        scope: 'platform',
        teams: [],
      });
      await runTeamsCommand(['directory'], ENV);
      expect(out()).toContain('--cursor=abc');
    });

    it('rejects a non-positive --limit without calling the gateway', async () => {
      const code = await runTeamsCommand(['directory', '--limit=0'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('--limit must be a positive integer');
      expect(calls).toHaveLength(0);
    });

    it('passes the organizations list through unchanged in --json', async () => {
      const organizations = [
        { id: 'org-2', name: 'Beta' },
        { id: 'org-1', name: 'Acme' },
      ];
      nextResponse = respond(200, { nextCursor: null, organizations, teams: [] });
      const code = await runTeamsCommand(['directory', '--json'], ENV);
      expect(code).toBe(0);
      expect(JSON.parse(out())).toEqual({ nextCursor: null, organizations, teams: [] });
    });

    it('keeps the human table free of the organizations list', async () => {
      nextResponse = respond(200, {
        nextCursor: null,
        organizations: [{ id: 'org-9', name: 'Zeta Holdings' }],
        teams: [],
      });
      await runTeamsCommand(['directory'], ENV);
      expect(out()).toBe('No teams match.\n');
    });

    it('rejects an unknown flag', async () => {
      const code = await runTeamsCommand(['directory', '--bogus=1'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('Unknown flag: --bogus');
    });
  });

  describe('request', () => {
    it('posts the message to the team join-requests route', async () => {
      nextResponse = respond(201, { id: 'req-1', status: 'PENDING_TEAM' });
      const code = await runTeamsCommand(['request', 'team-1', '--message=Hi there'], ENV);
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: { message: 'Hi there' },
        method: 'POST',
        url: 'http://gw/api/v1/teams/team-1/join-requests',
      });
      expect(out()).toContain('request req-1 is PENDING_TEAM');
    });

    it('sends an empty message when none is given', async () => {
      nextResponse = respond(201, { id: 'req-1', status: 'PENDING_TEAM' });
      await runTeamsCommand(['request', 'team-1'], ENV);
      expect(calls[0]?.body).toEqual({ message: '' });
    });

    it('prints the created request as JSON with --json', async () => {
      nextResponse = respond(201, { id: 'req-1', status: 'PENDING_ORG' });
      await runTeamsCommand(['request', 'team-1', '--json'], ENV);
      expect(JSON.parse(out())).toEqual({ id: 'req-1', status: 'PENDING_ORG' });
    });

    it('refuses a message over 500 characters', async () => {
      const code = await runTeamsCommand(
        ['request', 'team-1', `--message=${'x'.repeat(501)}`],
        ENV
      );
      expect(code).toBe(1);
      expect(err()).toContain('at most 500 characters');
      expect(calls).toHaveLength(0);
    });

    it('needs a team id', async () => {
      const code = await runTeamsCommand(['request'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('Usage: teams request <teamId>');
    });

    it('names the earlier decision when the cooldown reports a reason', async () => {
      nextResponse = respond(429, {
        error: {
          code: 'JOIN_REQUEST_COOLDOWN',
          details: { reason: 'withdrawn', retryAfterSeconds: 120 },
          message: 'Try again later',
        },
      });
      const code = await runTeamsCommand(['request', 'team-1'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('JOIN_REQUEST_COOLDOWN: Try again later (reason: withdrawn)');
    });

    it('leaves the cooldown message alone when the reason is not one it knows', async () => {
      nextResponse = respond(429, {
        error: {
          code: 'JOIN_REQUEST_COOLDOWN',
          details: { reason: 'expired' },
          message: 'Try again later',
        },
      });
      const code = await runTeamsCommand(['request', 'team-1'], ENV);
      expect(code).toBe(2);
      expect(err()).toBe('JOIN_REQUEST_COOLDOWN: Try again later\n');
    });

    it('surfaces a gateway error code and exits 2', async () => {
      nextResponse = respond(429, {
        error: { code: 'JOIN_REQUEST_COOLDOWN', message: 'Try again later' },
      });
      const code = await runTeamsCommand(['request', 'team-1'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('JOIN_REQUEST_COOLDOWN: Try again later');
    });
  });

  describe('requests (own list)', () => {
    it('lists the caller requests', async () => {
      nextResponse = respond(200, [
        {
          id: 'req-1',
          orgName: 'Acme',
          status: 'REJECTED',
          teamDecisionNote: 'Not this quarter',
          teamName: 'Payments',
        },
      ]);
      const code = await runTeamsCommand(['requests'], ENV);
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: undefined,
        method: 'GET',
        url: 'http://gw/api/v1/me/join-requests',
      });
      expect(out()).toContain('REJECTED');
      expect(out()).toContain('Not this quarter');
    });

    it('prints an empty message when there are no requests', async () => {
      await runTeamsCommand(['requests'], ENV);
      expect(out()).toContain('No join requests.');
    });

    it('shows why a deactivation closed a request', async () => {
      nextResponse = respond(200, [
        {
          closeReason: 'TEAM_DEACTIVATED',
          id: 'req-1',
          status: 'REJECTED',
          teamName: 'Payments',
        },
        { closeReason: null, id: 'req-2', status: 'WITHDRAWN', teamName: 'Platform' },
      ]);
      await runTeamsCommand(['requests'], ENV);
      expect(out()).toContain('REJECTED (closed: team deactivated)');
      expect(out()).not.toContain('WITHDRAWN (closed');
    });

    it('prints the closeReason unchanged in --json', async () => {
      const rows = [{ closeReason: 'ORGANIZATION_DEACTIVATED', id: 'req-1', status: 'REJECTED' }];
      nextResponse = respond(200, rows);
      await runTeamsCommand(['requests', '--json'], ENV);
      expect(JSON.parse(out())).toEqual(rows);
    });

    it('notes under the table when the server says the list is truncated', async () => {
      nextResponse = respondWithMeta([{ id: 'req-1', status: 'PENDING_TEAM' }], {
        truncated: true,
      });
      const code = await runTeamsCommand(['requests'], ENV);
      expect(code).toBe(0);
      const lines = out().trimEnd().split('\n');
      expect(lines[lines.length - 1]).toBe(
        'Only the newest requests are listed; older ones are not shown.'
      );
    });

    it('prints no truncation note when the list is complete', async () => {
      nextResponse = respondWithMeta([{ id: 'req-1', status: 'PENDING_TEAM' }], {
        truncated: false,
      });
      await runTeamsCommand(['requests'], ENV);
      expect(out()).not.toContain('older ones');
    });

    it('keeps the --json output a bare array when the list is truncated', async () => {
      nextResponse = respondWithMeta([{ id: 'req-1', status: 'PENDING_TEAM' }], {
        truncated: true,
      });
      await runTeamsCommand(['requests', '--json'], ENV);
      expect(JSON.parse(out())).toEqual([{ id: 'req-1', status: 'PENDING_TEAM' }]);
    });

    it('prints the raw list with --json', async () => {
      nextResponse = respond(200, [{ id: 'req-1', status: 'PENDING_TEAM' }]);
      await runTeamsCommand(['requests', '--json'], ENV);
      expect(JSON.parse(out())).toEqual([{ id: 'req-1', status: 'PENDING_TEAM' }]);
    });
  });

  describe('requests withdraw', () => {
    it('posts to the withdraw route of the caller request', async () => {
      nextResponse = respond(200, { id: 'req-1', status: 'WITHDRAWN' });
      const code = await runTeamsCommand(['requests', 'withdraw', 'req-1'], ENV);
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: undefined,
        method: 'POST',
        url: 'http://gw/api/v1/me/join-requests/req-1/withdraw',
      });
      expect(out()).toContain('Withdrew request req-1: WITHDRAWN');
    });

    it('surfaces a refusal from the gateway', async () => {
      nextResponse = respond(409, {
        error: { code: 'REQUEST_CLOSED', message: 'Already decided' },
      });
      const code = await runTeamsCommand(['requests', 'withdraw', 'req-1'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('REQUEST_CLOSED');
    });

    it('needs a request id', async () => {
      const code = await runTeamsCommand(['requests', 'withdraw'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('Usage: teams requests withdraw <requestId>');
    });
  });

  describe('requests pending', () => {
    it('lists a team queue, filtered by status', async () => {
      nextResponse = respond(200, [
        {
          id: 'req-1',
          message: 'hello',
          requester: { email: 'bo@x.com', id: 'u-1', name: 'Bo' },
          requiresOrgApproval: true,
          status: 'PENDING_TEAM',
        },
      ]);
      const code = await runTeamsCommand(
        ['requests', 'pending', 'team-1', '--status=PENDING_TEAM'],
        ENV
      );
      expect(code).toBe(0);
      expect(calls[0]?.url).toBe('http://gw/api/v1/teams/team-1/join-requests?status=PENDING_TEAM');
      expect(out()).toContain('Bo');
      expect(out()).not.toContain('u-1');
      expect(out()).toContain('yes');
    });

    it('shows the close reason in the reviewer queue', async () => {
      nextResponse = respond(200, [
        {
          closeReason: 'REQUESTER_DEACTIVATED',
          id: 'req-1',
          requester: { id: 'u-1', name: 'Bo' },
          status: 'WITHDRAWN',
        },
      ]);
      await runTeamsCommand(['requests', 'pending', 'team-1'], ENV);
      expect(out()).toContain('WITHDRAWN (closed: requester deactivated)');
    });

    it('accepts --status=ALL', async () => {
      const code = await runTeamsCommand(['requests', 'pending', 'team-1', '--status=ALL'], ENV);
      expect(code).toBe(0);
      expect(calls[0]?.url).toBe('http://gw/api/v1/teams/team-1/join-requests?status=ALL');
    });

    it('omits the status filter when none is given', async () => {
      await runTeamsCommand(['requests', 'pending', 'team-1'], ENV);
      expect(calls[0]?.url).toBe('http://gw/api/v1/teams/team-1/join-requests');
    });

    it('rejects an unknown status before calling the gateway', async () => {
      const code = await runTeamsCommand(['requests', 'pending', 'team-1', '--status=DONE'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('--status must be one of');
      expect(calls).toHaveLength(0);
    });

    it('surfaces a permission refusal with exit 2', async () => {
      nextResponse = respond(403, { error: { code: 'FORBIDDEN', message: 'Not allowed' } });
      const code = await runTeamsCommand(['requests', 'pending', 'team-1'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('FORBIDDEN');
    });
  });

  describe('requests approve', () => {
    it('posts the chosen role and note to the team approve route', async () => {
      nextResponse = respond(200, { grantedRole: 'LEAD', id: 'req-1', status: 'APPROVED' });
      const code = await runTeamsCommand(
        ['requests', 'approve', 'team-1', 'req-1', '--role=LEAD', '--note=welcome'],
        ENV
      );
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: { note: 'welcome', role: 'LEAD' },
        method: 'POST',
        url: 'http://gw/api/v1/teams/team-1/join-requests/req-1/approve',
      });
      expect(out()).toContain('Approved request req-1: APPROVED');
    });

    it('sends an empty body when no role or note is given', async () => {
      nextResponse = respond(200, { id: 'req-1', status: 'PENDING_ORG' });
      await runTeamsCommand(['requests', 'approve', 'team-1', 'req-1'], ENV);
      expect(calls[0]?.body).toEqual({});
    });

    it('rejects a role outside the team roles', async () => {
      const code = await runTeamsCommand(
        ['requests', 'approve', 'team-1', 'req-1', '--role=OWNER'],
        ENV
      );
      expect(code).toBe(1);
      expect(err()).toContain('--role must be one of ADMIN, LEAD, MEMBER');
      expect(calls).toHaveLength(0);
    });

    it('does not accept --role on reject', async () => {
      const code = await runTeamsCommand(
        ['requests', 'reject', 'team-1', 'req-1', '--role=LEAD'],
        ENV
      );
      expect(code).toBe(1);
      expect(err()).toContain('Unknown flag: --role');
    });

    it('surfaces the gateway hierarchy refusal', async () => {
      nextResponse = respond(403, {
        error: { code: 'ROLE_ABOVE_APPROVER', message: 'Role exceeds yours' },
      });
      const code = await runTeamsCommand(
        ['requests', 'approve', 'team-1', 'req-1', '--role=ADMIN'],
        ENV
      );
      expect(code).toBe(2);
      expect(err()).toContain('ROLE_ABOVE_APPROVER');
    });
  });

  describe('requests reject', () => {
    it('posts the note to the team reject route', async () => {
      nextResponse = respond(200, { id: 'req-1', status: 'REJECTED' });
      const code = await runTeamsCommand(
        ['requests', 'reject', 'team-1', 'req-1', '--note=not now'],
        ENV
      );
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: { note: 'not now' },
        method: 'POST',
        url: 'http://gw/api/v1/teams/team-1/join-requests/req-1/reject',
      });
      expect(out()).toContain('Rejected request req-1: REJECTED');
    });

    it('needs both ids', async () => {
      const code = await runTeamsCommand(['requests', 'reject', 'team-1'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('Usage: teams requests reject <teamId> <requestId>');
    });

    it('refuses a note over 500 characters', async () => {
      const code = await runTeamsCommand(
        ['requests', 'reject', 'team-1', 'req-1', `--note=${'n'.repeat(501)}`],
        ENV
      );
      expect(code).toBe(1);
      expect(calls).toHaveLength(0);
    });

    it('prints the decided request as JSON with --json', async () => {
      nextResponse = respond(200, { id: 'req-1', status: 'REJECTED' });
      await runTeamsCommand(['requests', 'reject', 'team-1', 'req-1', '--json'], ENV);
      expect(JSON.parse(out())).toEqual({ id: 'req-1', status: 'REJECTED' });
    });
  });

  it('reports an unknown subcommand', async () => {
    const code = await runTeamsCommand(['frobnicate'], ENV);
    expect(code).toBe(1);
    expect(err()).toContain('Unknown subcommand: teams frobnicate');
  });

  it('reports an unknown requests action', async () => {
    const code = await runTeamsCommand(['requests', 'frobnicate'], ENV);
    expect(code).toBe(1);
    expect(err()).toContain('Unknown subcommand: teams requests frobnicate');
  });

  it('prints help with no subcommand', async () => {
    const code = await runTeamsCommand([], ENV);
    expect(code).toBe(0);
    expect(out()).toContain('teams directory');
  });
});
