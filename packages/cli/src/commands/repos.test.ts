import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReposCommand } from './repos.js';

const ENV = { apiUrl: 'http://gw', token: 't' };
const REPO = {
  gateCommands: { runTests: 'npm test' },
  id: 'repo-1',
  organizationName: 'acme',
  repoName: 'api',
};

describe('runReposCommand gate-commands', () => {
  let out: string[];
  let err: string[];
  let calls: Array<{ method: string; url: string; body: unknown }>;
  const originals = {
    err: process.stderr.write,
    fetch: globalThis.fetch,
    out: process.stdout.write,
  };

  function respond(patchStatus = 200, patchBody: unknown = { data: REPO }) {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, method, url });
      if (method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [REPO], meta: { total: 1 } }),
        } as unknown as Response;
      }
      return {
        ok: patchStatus < 300,
        status: patchStatus,
        text: async () => JSON.stringify(patchBody),
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

  it('prints every gate, with the built-in default where none is set', async () => {
    respond();
    expect(await runReposCommand(['gate-commands', 'acme/api'], ENV)).toBe(0);
    const text = out.join('');
    expect(text).toMatch(/tests\s+npm test/);
    expect(text).toMatch(/lint\s+\(built-in default\)/);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('sends the full set: the stored ones, the new one, minus an emptied one', async () => {
    respond(200, { data: { ...REPO, gateCommands: { runLint: 'pnpm lint' } } });
    const code = await runReposCommand(
      ['gate-commands', 'acme/api', '--lint=pnpm lint', '--tests='],
      ENV
    );
    expect(code).toBe(0);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe('http://gw/api/v1/repositories/repo-1');
    expect(patch?.body).toEqual({ gateCommands: { runLint: 'pnpm lint' } });
  });

  it('sends null for --clear with nothing set after it', async () => {
    respond(200, { data: { ...REPO, gateCommands: null } });
    await runReposCommand(['gate-commands', 'acme/api', '--clear'], ENV);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ gateCommands: null });
  });

  it('exits 2 with the gateway refusal for someone without the role', async () => {
    respond(403, {
      error: {
        code: 'GATE_COMMANDS_FORBIDDEN',
        message: "Changing a repository's gate commands requires team-admin role",
      },
    });
    expect(await runReposCommand(['gate-commands', 'acme/api', '--tests=make'], ENV)).toBe(2);
    expect(err.join('')).toMatch(/GATE_COMMANDS_FORBIDDEN/);
  });

  it('refuses a gate flag with no value, an unknown flag, and a bad repository name', async () => {
    respond();
    expect(await runReposCommand(['gate-commands', 'acme/api', '--tests'], ENV)).toBe(1);
    expect(await runReposCommand(['gate-commands', 'acme/api', '--deploy=x'], ENV)).toBe(1);
    expect(await runReposCommand(['gate-commands', 'acme'], ENV)).toBe(1);
    expect(calls).toEqual([]);
  });

  it('reports a repository it cannot find', async () => {
    respond();
    expect(await runReposCommand(['gate-commands', 'acme/nope'], ENV)).toBe(1);
    expect(err.join('')).toMatch(/not found/);
  });
});
