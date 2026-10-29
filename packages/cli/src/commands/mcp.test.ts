import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../index.js';
import type { McpCredentials } from '../lib/mcpCredentials.js';
import { runMcpCommand } from './mcp.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }));

const BASE = 'https://auto-swe.example.test';
const OTHER = 'https://other.example.test';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const TOKEN = {
  access_token: 'access-fixture',
  expires_in: 600,
  refresh_token: 'refresh-fixture',
  scope: 'mcp:read offline_access',
  token_type: 'Bearer',
};

describe('auto-swe mcp', () => {
  let directory: string;
  let file: string;
  let now: number;
  let out: string[];
  let err: string[];
  let calls: Array<{ url: string; init?: RequestInit }>;
  let polls: Array<{ status?: number; body: Record<string, unknown> }>;
  let metadataOverride: Record<string, unknown>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'auto-swe-mcp-'));
    file = join(directory, 'auto-swe', 'mcp-credentials.json');
    now = 1_793_280_000_000;
    out = [];
    err = [];
    calls = [];
    polls = [];
    metadataOverride = {};
    vi.stubEnv('XDG_CONFIG_HOME', directory);
    vi.stubEnv('AUTO_SWE_API_URL', BASE);
    vi.stubEnv('AUTO_SWE_TOKEN', '');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(delay).mockImplementation(async (milliseconds) => {
      now += milliseconds ?? 0;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ init, url });
        const base = new URL(url).origin;
        if (url.includes('/.well-known/')) {
          return Response.json({
            device_authorization_endpoint: `${base}/api/auth/device/code`,
            issuer: `${base}/api/auth`,
            registration_endpoint: `${base}/api/auth/oauth2/register`,
            revocation_endpoint: `${base}/api/auth/oauth2/revoke`,
            token_endpoint: `${base}/api/auth/oauth2/token`,
            ...metadataOverride,
          });
        }
        if (url.endsWith('/register')) {
          return Response.json({ client_id: `client-${base}` }, { status: 201 });
        }
        if (url.endsWith('/device/code')) {
          return Response.json({
            device_code: 'device-fixture',
            expires_in: 600,
            interval: 5,
            user_code: 'ABCD-EFGH',
            verification_uri_complete: 'https://web.example.test/device?user_code=ABCD-EFGH',
          });
        }
        if (url.endsWith('/token')) {
          const next = polls.shift() ?? { body: TOKEN, status: 200 };
          return Response.json(next.body, { status: next.status ?? 200 });
        }
        if (url.endsWith('/revoke')) {
          return new Response(null, { status: 200 });
        }
        throw new Error('Unexpected OAuth request');
      })
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.mocked(delay).mockReset();
    await rm(directory, { force: true, recursive: true });
  });

  const read = async (): Promise<Record<string, McpCredentials>> =>
    JSON.parse(await readFile(file, 'utf8'));
  const form = (suffix: string) =>
    new URLSearchParams(String(calls.find((call) => call.url.endsWith(suffix))?.init?.body));
  const noSecrets = () => {
    expect(err.join('')).not.toMatch(/access-fixture|refresh-fixture|device-fixture/);
  };

  it('logs in without REST credentials, printing only the approval instructions to stderr', async () => {
    polls.push({ body: { error: 'authorization_pending' }, status: 400 });
    expect(await main(['mcp', 'login', '--write'])).toBe(0);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('https://web.example.test/device?user_code=ABCD-EFGH');
    expect(err.join('')).toContain('User code: ABCD-EFGH');
    noSecrets();
    expect(form('/device/code').get('scope')).toBe('mcp:read mcp:write offline_access');
    expect(form('/device/code').get('resource')).toBe(`${BASE}/api/v1/mcp`);
    expect(form('/token').get('grant_type')).toBe(GRANT);
    const registration = JSON.parse(
      String(calls.find((call) => call.url.endsWith('/register'))?.init?.body)
    );
    expect(registration).toMatchObject({
      grant_types: [GRANT, 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
    expect(calls.every((call) => call.init?.redirect === 'error')).toBe(true);
    expect((await read())[BASE]).toEqual({
      accessToken: TOKEN.access_token,
      accessTokenExpiresAt: now + 600_000,
      clientId: `client-${BASE}`,
      issuer: `${BASE}/api/auth`,
      refreshToken: TOKEN.refresh_token,
      resource: `${BASE}/api/v1/mcp`,
      scopes: ['mcp:read', 'offline_access'],
    });
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([5000, 5000]);
  });

  it('honours slow_down for all subsequent polls', async () => {
    polls.push(
      { body: { error: 'slow_down' }, status: 400 },
      { body: { error: 'authorization_pending' }, status: 400 }
    );
    expect(await runMcpCommand(['login', '--url', BASE])).toBe(0);
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([5000, 10_000, 10_000]);
    expect(form('/device/code').get('scope')).toBe('mcp:read offline_access');
    noSecrets();
  });

  it.each([
    ['access_denied', 'Device authorization denied'],
    ['expired_token', 'Device code expired'],
  ])(
    'handles %s without saving or leaking tokens and reuses registration on retry',
    async (error, message) => {
      polls.push({
        body: { error, error_description: 'access-fixture refresh-fixture device-fixture' },
        status: 400,
      });
      expect(await runMcpCommand(['login'])).toBe(1);
      expect(err.join('')).toContain(message);
      expect((await read())[BASE]?.accessToken).toBeUndefined();
      expect(out).toEqual([]);
      noSecrets();
      expect(await runMcpCommand(['login'])).toBe(0);
      expect(calls.filter((call) => call.url.endsWith('/register'))).toHaveLength(1);
    }
  );

  it('stops when the code lifetime elapses even if the provider keeps reporting pending', async () => {
    polls = Array.from({ length: 200 }, () => ({
      body: { error: 'authorization_pending' },
      status: 400,
    }));
    expect(await runMcpCommand(['login'])).toBe(1);
    expect(err.join('')).toContain('Device code expired');
    expect(calls.filter((call) => call.url.endsWith('/token')).length).toBeLessThan(120);
    expect((await read())[BASE]?.accessToken).toBeUndefined();
    noSecrets();
  });

  it('writes private files atomically and preserves other deployment entries', async () => {
    expect(await runMcpCommand(['login', '--url', OTHER])).toBe(0);
    expect(await runMcpCommand(['login'])).toBe(0);
    expect(Object.keys(await read()).sort()).toEqual([BASE, OTHER].sort());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'auto-swe'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(directory, 'auto-swe'))).toEqual(['mcp-credentials.json']);
    await chmod(file, 0o644);
    await chmod(join(directory, 'auto-swe'), 0o755);
    expect(await runMcpCommand(['token'])).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'auto-swe'))).mode & 0o777).toBe(0o700);
  });

  it('prints a cached token or header only to stdout without network access', async () => {
    expect(await runMcpCommand(['login'])).toBe(0);
    calls = [];
    out = [];
    err = [];
    expect(await runMcpCommand(['token'])).toBe(0);
    expect(await runMcpCommand(['header'])).toBe(0);
    expect(out).toEqual(['access-fixture\n', '{"Authorization":"Bearer access-fixture"}\n']);
    expect(err).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('refreshes below sixty seconds and persists rotation before returning a token', async () => {
    expect(await runMcpCommand(['login'])).toBe(0);
    now += 541_000;
    calls = [];
    polls.push({
      body: { ...TOKEN, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    });
    expect(await runMcpCommand(['header'])).toBe(0);
    expect(out).toEqual(['{"Authorization":"Bearer rotated-access"}\n']);
    expect(form('/token').get('grant_type')).toBe('refresh_token');
    expect(form('/token').get('refresh_token')).toBe('refresh-fixture');
    expect(form('/token').get('resource')).toBe(`${BASE}/api/v1/mcp`);
    expect((await read())[BASE]).toMatchObject({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
    });
    noSecrets();
    expect(err.join('')).not.toMatch(/rotated-access|rotated-refresh/);
  });

  it('requires another login on invalid_grant, never printing the provider error text', async () => {
    expect(await runMcpCommand(['login'])).toBe(0);
    now += 541_000;
    polls.push({
      body: { error: 'invalid_grant', error_description: 'refresh-fixture' },
      status: 400,
    });
    expect(await runMcpCommand(['token'])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('Run auto-swe mcp login again');
    noSecrets();
  });

  it('revokes the refresh token and removes only the selected deployment', async () => {
    expect(await runMcpCommand(['login'])).toBe(0);
    expect(await runMcpCommand(['login', '--url', OTHER])).toBe(0);
    expect(await runMcpCommand(['logout'])).toBe(0);
    expect(form('/revoke').get('token')).toBe('refresh-fixture');
    expect(form('/revoke').get('token_type_hint')).toBe('refresh_token');
    expect(Object.keys(await read())).toEqual([OTHER]);
    expect(out).toEqual([]);
    noSecrets();
  });

  it('reports empty credentials and makes logout idempotent', async () => {
    expect(await runMcpCommand(['token'])).toBe(1);
    expect(err.join('')).toContain('No MCP credentials');
    expect(await runMcpCommand(['logout'])).toBe(0);
    expect(await read()).toEqual({});
    expect(calls).toEqual([]);
  });

  it('keeps credentials when revocation fails, without printing remote diagnostics', async () => {
    expect(await runMcpCommand(['login'])).toBe(0);
    const before = await readFile(file, 'utf8');
    const responder = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/revoke')) {
        return Response.json(
          { error: 'server_error', error_description: 'refresh-fixture' },
          { status: 503 }
        );
      }
      if (!responder) {
        throw new Error('Missing responder');
      }
      return responder(input, init);
    });
    expect(await runMcpCommand(['logout'])).toBe(1);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(join(directory, 'auto-swe'))).toEqual(['mcp-credentials.json']);
    expect(out).toEqual([]);
    noSecrets();
  });

  it('does not print fetch exception messages that might contain credential diagnostics', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('refresh-fixture access-fixture'));
    expect(await runMcpCommand(['login'])).toBe(1);
    expect(out).toEqual([]);
    noSecrets();
    expect(err.join('')).toContain('Check the deployment URL and connection');
  });

  it('rejects cross-origin discovery endpoints and disabled device flow before registration', async () => {
    metadataOverride = { token_endpoint: `${OTHER}/steal` };
    expect(await runMcpCommand(['login'])).toBe(1);
    expect(err.join('')).toContain('configured gateway origin');
    metadataOverride = { device_authorization_endpoint: undefined };
    expect(await runMcpCommand(['login'])).toBe(1);
    expect(err.join('')).toContain('unavailable');
    expect(calls.filter((call) => call.url.endsWith('/register'))).toHaveLength(0);
    expect(out).toEqual([]);
  });

  it('fails closed on corrupt credential storage without echoing its contents', async () => {
    expect(await runMcpCommand(['login'])).toBe(0);
    await writeFile(file, '{"accessToken":"access-fixture');
    expect(await runMcpCommand(['header'])).toBe(1);
    expect(out).toEqual([]);
    noSecrets();
  });

  it.each([
    ['login', '--url'],
    ['login', '--write=false'],
    ['token', '--write'],
    ['login', '--url', 'http://unsafe.example.test'],
  ])('rejects invalid arguments %j without network access', async (...args) => {
    expect(await runMcpCommand(args)).toBe(1);
    expect(calls).toEqual([]);
    expect(out).toEqual([]);
  });
});
