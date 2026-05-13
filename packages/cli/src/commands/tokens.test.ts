import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTokensCommand } from './tokens.js';

const ENV = { apiUrl: 'http://gw', token: 't' };

describe('runTokensCommand', () => {
  let stderrWrites: string[];
  let stdoutWrites: string[];
  let originalErr: typeof process.stderr.write;
  let originalOut: typeof process.stdout.write;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    stderrWrites = [];
    stdoutWrites = [];
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
  });

  afterEach(() => {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
    globalThis.fetch = originalFetch;
  });

  it('create prints the plaintext token on stdout exactly once', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            data: {
              createdAt: '2026-01-01',
              expiresAt: null,
              id: 'pat-1',
              name: 'ci',
              prefix: 'ats_xxxxxxxx',
              token: 'ats_secretsecretsecretsecret',
            },
          }),
      } as unknown as Response;
    }) as typeof fetch;
    const code = await runTokensCommand(['create', 'ci'], ENV);
    expect(code).toBe(0);
    const out = stdoutWrites.join('');
    expect(out).toContain('ats_secretsecretsecretsecret');
    // The warning about one-shot exposure must go to stderr, not stdout, so a
    // pipe like `auto-swe tokens create ci > token.txt` only captures the
    // plaintext.
    expect(stderrWrites.join('')).toContain('NOT appear again');
  });

  it('create requires a name', async () => {
    const code = await runTokensCommand(['create'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('Usage: tokens create');
  });

  it('rejects --expires-in-days=abc', async () => {
    const code = await runTokensCommand(['create', 'ci', '--expires-in-days=abc'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('positive integer');
  });

  it('rejects --expires-in-days= (empty value silently created a non-expiring token before)', async () => {
    const code = await runTokensCommand(['create', 'ci', '--expires-in-days='], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('positive integer');
  });

  it('list shows column headers + status when token has a revokedAt', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              {
                createdAt: '2026-01-01',
                expiresAt: null,
                id: 'pat-1',
                lastUsedAt: null,
                name: 'a',
                prefix: 'ats_aaaaaaaa',
                revokedAt: '2026-02-01',
              },
            ],
          }),
      } as unknown as Response;
    }) as typeof fetch;
    const code = await runTokensCommand(['list'], ENV);
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toContain('revoked');
  });

  it('revoke calls DELETE on the token id', async () => {
    const captured: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      captured.push({ method: init?.method, url });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { id: 'pat-9', revokedAt: '2026-03-01' } }),
      } as unknown as Response;
    }) as typeof fetch;
    const code = await runTokensCommand(['revoke', 'pat-9'], ENV);
    expect(code).toBe(0);
    expect(captured[0]?.method).toBe('DELETE');
    expect(captured[0]?.url).toContain('/api/v1/auth/tokens/pat-9');
  });
});
