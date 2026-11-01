import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runConnectionsCommand } from './connections.js';
import { runReposCommand } from './repos.js';

const ENV = { apiUrl: 'http://gw', token: 't' };
const REPO = { id: 'repo-1', organizationName: 'acme', repoName: 'api' };

let out: string[];
let err: string[];
let calls: Array<{ method: string; url: string; body: unknown }>;
const originals = {
  err: process.stderr.write,
  fetch: globalThis.fetch,
  out: process.stdout.write,
};

function respond(handlers: Record<string, { status?: number; body: unknown }>) {
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, method, url });
    const path = url.replace('http://gw', '').split('?')[0];
    const hit = handlers[`${method} ${path}`];
    if (!hit) {
      throw new Error(`No mock for ${method} ${path}`);
    }
    const status = hit.status ?? 200;
    return {
      ok: status < 300,
      status,
      text: async () => JSON.stringify(hit.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  out = [];
  err = [];
  calls = [];
  process.stdout.write = ((s: string) => {
    out.push(s);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    err.push(s);
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stdout.write = originals.out;
  process.stderr.write = originals.err;
  globalThis.fetch = originals.fetch;
});

const entry = (over: Record<string, unknown>) => ({
  detail: 'fine',
  id: 'github',
  label: 'GitHub',
  status: 'ok',
  ...over,
});

describe('connections test', () => {
  const PATH = 'POST /api/v1/platform/connections/test';

  it('prints failing connections first and exits 1 when any fails', async () => {
    respond({
      [PATH]: {
        body: {
          data: [
            entry({ detail: 'Not configured.', id: 'figma', label: 'Figma', status: 'skipped' }),
            entry({}),
            entry({ detail: 'invalid_auth', id: 'slack', label: 'Slack', status: 'failed' }),
          ],
        },
      },
    });
    expect(await runConnectionsCommand(['test'], ENV)).toBe(1);
    const lines = out.join('').split('\n');
    expect(lines[0]).toMatch(/^failed\s+Slack\s+invalid_auth$/);
    expect(lines[1]).toMatch(/^ok\s+GitHub\s+fine$/);
    expect(lines[2]).toMatch(/^skipped\s+Figma\s+Not configured\.$/);
    expect(out.join('')).toContain('1 of 2 configured connections failing.');
    expect(calls[0]?.body).toEqual({});
  });

  it('exits 0 when everything configured works', async () => {
    respond({ [PATH]: { body: { data: [entry({})] } } });
    expect(await runConnectionsCommand(['test'], ENV)).toBe(0);
    expect(out.join('')).toContain('All 1 configured connections work.');
  });

  it('exits 0 and says so when nothing is configured', async () => {
    respond({ [PATH]: { body: { data: [entry({ status: 'skipped' })] } } });
    expect(await runConnectionsCommand(['test'], ENV)).toBe(0);
    expect(out.join('')).toContain('Nothing is configured to test yet.');
  });

  it('sends the ticket for the issue tracker', async () => {
    respond({ [PATH]: { body: { data: [] } } });
    await runConnectionsCommand(['test', '--ticket=PAY-1'], ENV);
    expect(calls[0]?.body).toEqual({ trackerTicketId: 'PAY-1' });
  });

  it('prints the gateway answer as JSON and still gates the exit code', async () => {
    const data = [entry({ status: 'failed' })];
    respond({ [PATH]: { body: { data } } });
    expect(await runConnectionsCommand(['test', '--json'], ENV)).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual(data);
  });

  it('exits 2 with the gateway refusal for someone who is not an admin', async () => {
    respond({
      [PATH]: {
        body: { error: { code: 'FORBIDDEN', message: 'Requires ADMIN role' } },
        status: 403,
      },
    });
    expect(await runConnectionsCommand(['test'], ENV)).toBe(2);
    expect(err.join('')).toMatch(/FORBIDDEN/);
  });

  it('refuses a ticket flag with no value, an unknown flag and an unknown subcommand', async () => {
    expect(await runConnectionsCommand(['test', '--ticket'], ENV)).toBe(1);
    expect(await runConnectionsCommand(['test', '--bogus'], ENV)).toBe(1);
    expect(await runConnectionsCommand(['nope'], ENV)).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe('repos test-access', () => {
  const ACCESS = 'POST /api/v1/repositories/repo-1/test-access';
  const list = { body: { data: [REPO], meta: { total: 1 } } };

  it('prints each step and exits 0 when every step passes', async () => {
    respond({
      'GET /api/v1/repositories': list,
      [ACCESS]: {
        body: {
          data: {
            checks: [
              { detail: 'Platform credential can push to acme/api.', name: 'x', ok: true },
              { detail: 'Default branch main exists.', name: 'y', ok: true },
            ],
            detail: 'ok',
            ok: true,
          },
        },
      },
    });
    expect(await runReposCommand(['test-access', 'acme/api'], ENV)).toBe(0);
    expect(out.join('')).toMatch(/ok\s+Platform credential can push to acme\/api\./);
    expect(out.join('')).toContain('acme/api is reachable.');
  });

  it('exits 1 when a step fails, naming it', async () => {
    respond({
      'GET /api/v1/repositories': list,
      [ACCESS]: {
        body: {
          data: {
            checks: [{ detail: 'GitHub returned 404.', name: 'x', ok: false }],
            detail: 'GitHub returned 404.',
            ok: false,
          },
        },
      },
    });
    expect(await runReposCommand(['test-access', 'acme/api'], ENV)).toBe(1);
    expect(out.join('')).toMatch(/failed\s+GitHub returned 404\./);
  });

  it('exits 2 for someone who may not manage the repository', async () => {
    respond({
      'GET /api/v1/repositories': list,
      [ACCESS]: {
        body: {
          error: { code: 'FORBIDDEN', message: "Requires LEAD role in this repository's team" },
        },
        status: 403,
      },
    });
    expect(await runReposCommand(['test-access', 'acme/api'], ENV)).toBe(2);
  });

  it('refuses a bad repository name, and reports one it cannot find', async () => {
    expect(await runReposCommand(['test-access', 'acme'], ENV)).toBe(1);
    respond({ 'GET /api/v1/repositories': { body: { data: [], meta: { total: 0 } } } });
    expect(await runReposCommand(['test-access', 'acme/api'], ENV)).toBe(1);
    expect(err.join('')).toMatch(/not found/);
  });
});
