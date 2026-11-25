import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOrgsCommand } from './orgs.js';

const ENV = { apiUrl: 'http://gw', token: 't' };

function respond(status: number, data: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    text: async () => JSON.stringify(ok ? { data } : data),
  } as unknown as Response;
}

describe('runOrgsCommand', () => {
  let stderrWrites: string[];
  let stdoutWrites: string[];
  let originalErr: typeof process.stderr.write;
  let originalOut: typeof process.stdout.write;
  let originalFetch: typeof globalThis.fetch;
  let calls: { method: string; url: string; body: unknown }[];
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

  describe('requests <orgId>', () => {
    it('lists the organization queue with its status filter', async () => {
      nextResponse = respond(200, [
        {
          grantedRole: 'LEAD',
          id: 'req-1',
          message: 'please',
          requester: { email: 'ada@other.com', id: 'u-9', name: 'Ada' },
          status: 'PENDING_ORG',
          teamName: 'Payments',
        },
      ]);
      const code = await runOrgsCommand(['requests', 'org-1', '--status=PENDING_ORG'], ENV);
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: undefined,
        method: 'GET',
        url: 'http://gw/api/v1/platform/organizations/org-1/join-requests?status=PENDING_ORG',
      });
      expect(out()).toContain('req-1');
      expect(out()).toContain('Payments');
      expect(out()).toContain('ROLE');
      expect(out()).toContain('LEAD');
      expect(out()).toContain('Ada');
      expect(out()).not.toContain('u-9');
    });

    it('shows the close reason in the organization queue', async () => {
      nextResponse = respond(200, [
        {
          closeReason: 'TEAM_DEACTIVATED',
          id: 'req-1',
          requester: { id: 'u-9', name: 'Ada' },
          status: 'REJECTED',
          teamName: 'Payments',
        },
      ]);
      await runOrgsCommand(['requests', 'org-1'], ENV);
      expect(out()).toContain('REJECTED (closed: team deactivated)');
    });

    it('falls back from name to email to id for the requester', async () => {
      nextResponse = respond(200, [
        { id: 'r1', requester: { email: 'e@x.com', id: 'u1', name: null }, status: 'PENDING_ORG' },
        { id: 'r2', requester: { email: '', id: 'u2', name: null }, status: 'PENDING_ORG' },
      ]);
      await runOrgsCommand(['requests', 'org-1'], ENV);
      expect(out()).toContain('e@x.com');
      expect(out()).toContain('u2');
    });

    it('accepts --status=ALL', async () => {
      const code = await runOrgsCommand(['requests', 'org-1', '--status=ALL'], ENV);
      expect(code).toBe(0);
      expect(calls[0]?.url).toBe(
        'http://gw/api/v1/platform/organizations/org-1/join-requests?status=ALL'
      );
    });

    it('omits the filter when no status is given', async () => {
      await runOrgsCommand(['requests', 'org-1'], ENV);
      expect(calls[0]?.url).toBe('http://gw/api/v1/platform/organizations/org-1/join-requests');
    });

    it('prints the raw list with --json', async () => {
      nextResponse = respond(200, [{ id: 'req-1', status: 'PENDING_ORG' }]);
      await runOrgsCommand(['requests', 'org-1', '--json'], ENV);
      expect(JSON.parse(out())).toEqual([{ id: 'req-1', status: 'PENDING_ORG' }]);
    });

    it('rejects an unknown status before calling the gateway', async () => {
      const code = await runOrgsCommand(['requests', 'org-1', '--status=NOPE'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('--status must be one of');
      expect(calls).toHaveLength(0);
    });

    it('needs an organization id', async () => {
      const code = await runOrgsCommand(['requests'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('Usage: orgs requests <orgId>');
    });

    it('surfaces a permission refusal with exit 2', async () => {
      nextResponse = respond(403, { error: { code: 'FORBIDDEN', message: 'Not an admin' } });
      const code = await runOrgsCommand(['requests', 'org-1'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('FORBIDDEN: Not an admin');
    });
  });

  describe('requests approve', () => {
    it('posts the note to the organization approve route', async () => {
      nextResponse = respond(200, { id: 'req-1', status: 'APPROVED' });
      const code = await runOrgsCommand(
        ['requests', 'approve', 'org-1', 'req-1', '--note=ok'],
        ENV
      );
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: { note: 'ok' },
        method: 'POST',
        url: 'http://gw/api/v1/platform/organizations/org-1/join-requests/req-1/approve',
      });
      expect(out()).toContain('Approved organization step for req-1: APPROVED');
    });

    it('sends an empty body without a note', async () => {
      nextResponse = respond(200, { id: 'req-1', status: 'APPROVED' });
      await runOrgsCommand(['requests', 'approve', 'org-1', 'req-1'], ENV);
      expect(calls[0]?.body).toEqual({});
    });

    it('does not accept --role (the team step chooses it)', async () => {
      const code = await runOrgsCommand(
        ['requests', 'approve', 'org-1', 'req-1', '--role=LEAD'],
        ENV
      );
      expect(code).toBe(1);
      expect(err()).toContain('Unknown flag: --role');
      expect(calls).toHaveLength(0);
    });

    it('surfaces a gateway refusal of a requester who is no longer active', async () => {
      nextResponse = respond(409, {
        error: { code: 'REQUESTER_INACTIVE', message: 'The requester is no longer active' },
      });
      const code = await runOrgsCommand(['requests', 'approve', 'org-1', 'req-1'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('REQUESTER_INACTIVE');
    });
  });

  describe('requests reject', () => {
    it('posts to the organization reject route', async () => {
      nextResponse = respond(200, { id: 'req-1', status: 'REJECTED' });
      const code = await runOrgsCommand(['requests', 'reject', 'org-1', 'req-1'], ENV);
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: {},
        method: 'POST',
        url: 'http://gw/api/v1/platform/organizations/org-1/join-requests/req-1/reject',
      });
      expect(out()).toContain('Rejected organization step for req-1: REJECTED');
    });

    it('prints the decided request as JSON with --json', async () => {
      nextResponse = respond(200, { id: 'req-1', status: 'REJECTED' });
      await runOrgsCommand(['requests', 'reject', 'org-1', 'req-1', '--json'], ENV);
      expect(JSON.parse(out())).toEqual({ id: 'req-1', status: 'REJECTED' });
    });

    it('needs both ids', async () => {
      const code = await runOrgsCommand(['requests', 'reject', 'org-1'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('Usage: orgs requests reject <orgId> <requestId>');
    });
  });

  it('reports an unknown subcommand', async () => {
    const code = await runOrgsCommand(['members'], ENV);
    expect(code).toBe(1);
    expect(err()).toContain('Unknown subcommand: orgs members');
  });

  describe('deactivate and reactivate', () => {
    it('PATCHes isActive false for deactivate and prints the name and new state', async () => {
      nextResponse = respond(200, {
        id: 'org-1',
        isActive: false,
        name: 'Acme',
        slug: 'acme',
        trustedInvites: false,
      });
      const code = await runOrgsCommand(['deactivate', 'org-1'], ENV);
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: { isActive: false },
        method: 'PATCH',
        url: 'http://gw/api/v1/platform/organizations/org-1',
      });
      expect(out()).toBe('Organization Acme is now inactive.\n');
    });

    it('PATCHes isActive true for reactivate and prints the new state', async () => {
      nextResponse = respond(200, { id: 'org-1', isActive: true, name: 'Acme' });
      const code = await runOrgsCommand(['reactivate', 'org-1'], ENV);
      expect(code).toBe(0);
      expect(calls[0]?.body).toEqual({ isActive: true });
      expect(calls[0]?.method).toBe('PATCH');
      expect(out()).toBe('Organization Acme is now active.\n');
    });

    it('falls back to the id when the response carries no name', async () => {
      nextResponse = respond(200, {});
      await runOrgsCommand(['deactivate', 'org-1'], ENV);
      expect(out()).toBe('Deactivated organization org-1.\n');
    });

    it('prints the organization as JSON with --json', async () => {
      const org = { id: 'org-1', isActive: true, name: 'Acme', slug: 'acme' };
      nextResponse = respond(200, org);
      const code = await runOrgsCommand(['reactivate', 'org-1', '--json'], ENV);
      expect(code).toBe(0);
      expect(JSON.parse(out())).toEqual(org);
    });

    it('surfaces DEFAULT_ORGANIZATION with exit 2', async () => {
      nextResponse = respond(409, {
        error: {
          code: 'DEFAULT_ORGANIZATION',
          message: 'The organization that owns the default team cannot be deactivated',
        },
      });
      const code = await runOrgsCommand(['deactivate', 'org-1'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain(
        'DEFAULT_ORGANIZATION: The organization that owns the default team cannot be deactivated'
      );
    });

    it('surfaces FORBIDDEN with exit 2', async () => {
      nextResponse = respond(403, {
        error: { code: 'FORBIDDEN', message: 'Not a platform admin' },
      });
      const code = await runOrgsCommand(['reactivate', 'org-1'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('FORBIDDEN: Not a platform admin');
    });

    it('surfaces NOT_FOUND with exit 2', async () => {
      nextResponse = respond(404, {
        error: { code: 'NOT_FOUND', message: 'Organization not found' },
      });
      const code = await runOrgsCommand(['deactivate', 'org-404'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('NOT_FOUND: Organization not found');
    });

    it('needs exactly one organization id and no unknown flags', async () => {
      expect(await runOrgsCommand(['deactivate'], ENV)).toBe(1);
      expect(err()).toContain('Usage: orgs deactivate <orgId>');
      expect(await runOrgsCommand(['reactivate', 'org-1', 'extra'], ENV)).toBe(1);
      expect(await runOrgsCommand(['deactivate', 'org-1', '--note=x'], ENV)).toBe(1);
      expect(err()).toContain('Unknown flag: --note');
      expect(calls).toHaveLength(0);
    });
  });
});
