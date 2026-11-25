import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNotificationsCommand } from './notifications.js';

const ENV = { apiUrl: 'http://gw', token: 't' };
const NOTE_ID = '6f1c2d3e-0000-4000-8000-000000000001';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A success or refusal shaped like the gateway: `{ data }` on success, the error body otherwise. */
function respond(status: number, data: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    text: async () => JSON.stringify(ok ? { data } : data),
  } as unknown as Response;
}

/** A success whose body is the list envelope `{ data, meta }`, returned as sent. */
function listEnvelope(data: unknown, meta: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data, meta }),
  } as unknown as Response;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    attempts: 3,
    audience: 'TEAM_MANAGERS',
    channel: 'EMAIL',
    createdAt: '2026-11-20T10:00:00.000Z',
    deliveredAt: null,
    event: 'REQUESTED',
    id: NOTE_ID,
    lastError: 'SMTP_REJECTED',
    nextAttemptAt: '2026-11-25T12:00:00.000Z',
    requestId: '6f1c2d3e-0000-4000-8000-0000000000aa',
    status: 'FAILED',
    teamId: '6f1c2d3e-0000-4000-8000-0000000000bb',
    teamName: 'Payments',
    updatedAt: '2026-11-25T11:00:00.000Z',
    ...overrides,
  };
}

describe('runNotificationsCommand', () => {
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
    nextResponse = listEnvelope([], {});
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

  it('prints the help text with no subcommand', async () => {
    const code = await runNotificationsCommand([], ENV);
    expect(code).toBe(0);
    expect(out()).toContain('notifications list');
    expect(out()).toContain('notifications retry <id>');
    expect(calls).toHaveLength(0);
  });

  it('reports an unknown subcommand', async () => {
    const code = await runNotificationsCommand(['purge'], ENV);
    expect(code).toBe(1);
    expect(err()).toContain('Unknown subcommand: notifications purge');
  });

  describe('list', () => {
    it('lists notifications as a table with the fixed columns', async () => {
      nextResponse = listEnvelope([row()], { nextCursor: null });
      const code = await runNotificationsCommand(['list'], ENV);
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: undefined,
        method: 'GET',
        url: 'http://gw/api/v1/platform/join-request-notifications',
      });
      const header = out().split('\n')[0] ?? '';
      for (const column of [
        'ID',
        'STATUS',
        'ATTEMPTS',
        'EVENT',
        'AUDIENCE',
        'TEAM',
        'NEXT ATTEMPT',
        'ERROR',
      ]) {
        expect(header).toContain(column);
      }
      expect(out()).toContain(NOTE_ID);
      expect(out()).toContain('FAILED');
      expect(out()).toContain('Payments');
      expect(out()).toContain('SMTP_REJECTED');
      expect(out()).toContain('2026-11-25T12:00:00.000Z');
    });

    it('prints only the returned fields, never anything else on the row', async () => {
      nextResponse = listEnvelope(
        [row({ email: 'someone@example.com', reached: ['u-1'], teamName: 'Payments' })],
        { nextCursor: null }
      );
      await runNotificationsCommand(['list'], ENV);
      expect(out()).not.toContain('someone@example.com');
      expect(out()).not.toContain('u-1');
    });

    it('shows a dash for an error or a team name the row does not carry', async () => {
      nextResponse = listEnvelope([row({ lastError: null, status: 'DELIVERED', teamName: null })], {
        nextCursor: null,
      });
      await runNotificationsCommand(['list'], ENV);
      const data = out().split('\n')[1] ?? '';
      expect(data).toContain('DELIVERED');
      expect(data.trimEnd().endsWith('-')).toBe(true);
    });

    it('sends status, limit and cursor as query parameters', async () => {
      nextResponse = listEnvelope([], { nextCursor: null });
      await runNotificationsCommand(
        ['list', '--status=FAILED', '--limit=20', '--cursor=Y3Vyc29y'],
        ENV
      );
      expect(calls[0]?.url).toBe(
        'http://gw/api/v1/platform/join-request-notifications?status=FAILED&limit=20&cursor=Y3Vyc29y'
      );
    });

    it('says when nothing matches', async () => {
      nextResponse = listEnvelope([], { nextCursor: null });
      const code = await runNotificationsCommand(['list'], ENV);
      expect(code).toBe(0);
      expect(out()).toBe('No notifications match.\n');
    });

    it('prints a cursor hint when another page exists', async () => {
      nextResponse = listEnvelope([row()], { nextCursor: 'bmV4dA' });
      await runNotificationsCommand(['list'], ENV);
      expect(out()).toContain('More notifications: add --cursor=bmV4dA');
    });

    it('prints the envelope unchanged with --json', async () => {
      const body = { data: [row()], meta: { nextCursor: 'bmV4dA' } };
      nextResponse = {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
      const code = await runNotificationsCommand(['list', '--json'], ENV);
      expect(code).toBe(0);
      expect(JSON.parse(out())).toEqual(body);
    });

    it('accepts each documented status', async () => {
      nextResponse = listEnvelope([], { nextCursor: null });
      for (const status of ['PENDING', 'DELIVERED', 'SKIPPED', 'FAILED']) {
        expect(await runNotificationsCommand(['list', `--status=${status}`], ENV)).toBe(0);
      }
      expect(calls).toHaveLength(4);
    });

    it('rejects an unknown status without calling the gateway', async () => {
      const code = await runNotificationsCommand(['list', '--status=ALL'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('--status must be one of PENDING, DELIVERED, SKIPPED, FAILED');
      expect(calls).toHaveLength(0);
    });

    it('rejects a bare --status with no value', async () => {
      const code = await runNotificationsCommand(['list', '--status'], ENV);
      expect(code).toBe(1);
      expect(err()).toContain('--status needs a value');
      expect(calls).toHaveLength(0);
    });

    it.each(['0', '101', '1.5', 'abc'])(
      'rejects --limit=%s without calling the gateway',
      async (limit) => {
        const code = await runNotificationsCommand(['list', `--limit=${limit}`], ENV);
        expect(code).toBe(1);
        expect(err()).toContain('--limit must be a whole number from 1 to 100');
        expect(calls).toHaveLength(0);
      }
    );

    it('rejects an unknown flag or a stray argument without calling the gateway', async () => {
      expect(await runNotificationsCommand(['list', '--team=x'], ENV)).toBe(1);
      expect(err()).toContain('Unknown flag: --team');
      expect(await runNotificationsCommand(['list', 'stray'], ENV)).toBe(1);
      expect(err()).toContain('Unexpected argument: stray');
      expect(calls).toHaveLength(0);
    });

    it('surfaces a refused cursor with exit 2', async () => {
      nextResponse = respond(400, {
        error: { code: 'INVALID_CURSOR', message: 'The cursor is not valid' },
      });
      const code = await runNotificationsCommand(['list', '--cursor=forged'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('INVALID_CURSOR: The cursor is not valid');
    });

    it('surfaces a permission refusal with exit 2', async () => {
      nextResponse = respond(403, {
        error: { code: 'FORBIDDEN', message: 'Not a platform admin' },
      });
      const code = await runNotificationsCommand(['list'], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('FORBIDDEN: Not a platform admin');
    });
  });

  describe('retry', () => {
    it('POSTs to the retry route and prints the re-queued status', async () => {
      nextResponse = respond(200, row({ attempts: 0, lastError: null, status: 'PENDING' }));
      const code = await runNotificationsCommand(['retry', NOTE_ID], ENV);
      expect(code).toBe(0);
      expect(calls[0]).toEqual({
        body: undefined,
        method: 'POST',
        url: `http://gw/api/v1/platform/join-request-notifications/${NOTE_ID}/retry`,
      });
      expect(out()).toBe(`Re-queued notification ${NOTE_ID}: PENDING.\n`);
    });

    it('prints the re-queued row as JSON with --json', async () => {
      const requeued = row({ attempts: 0, lastError: null, status: 'PENDING' });
      nextResponse = respond(200, requeued);
      const code = await runNotificationsCommand(['retry', NOTE_ID, '--json'], ENV);
      expect(code).toBe(0);
      expect(JSON.parse(out())).toEqual(requeued);
    });

    it('surfaces NOTIFICATION_NOT_FOUND with exit 2', async () => {
      nextResponse = respond(404, {
        error: { code: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found' },
      });
      const code = await runNotificationsCommand(['retry', NOTE_ID], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('NOTIFICATION_NOT_FOUND: Notification not found');
    });

    it('surfaces NOTIFICATION_NOT_FAILED with exit 2', async () => {
      nextResponse = respond(409, {
        error: {
          code: 'NOTIFICATION_NOT_FAILED',
          message: 'Only a failed notification can be retried',
        },
      });
      const code = await runNotificationsCommand(['retry', NOTE_ID], ENV);
      expect(code).toBe(2);
      expect(err()).toContain('NOTIFICATION_NOT_FAILED: Only a failed notification can be retried');
    });

    it('needs exactly one id and no unknown flags', async () => {
      expect(await runNotificationsCommand(['retry'], ENV)).toBe(1);
      expect(err()).toContain('Usage: notifications retry <id>');
      expect(await runNotificationsCommand(['retry', NOTE_ID, 'extra'], ENV)).toBe(1);
      expect(await runNotificationsCommand(['retry', NOTE_ID, '--all'], ENV)).toBe(1);
      expect(err()).toContain('Unknown flag: --all');
      expect(calls).toHaveLength(0);
    });
  });
});
