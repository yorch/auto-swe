import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, NetworkError, runWithExitCodes } from './api.js';

const ENV = { apiUrl: 'http://gw.invalid:8080', token: 't' };

describe('apiRequest network failures', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('names the URL and unwraps the cause instead of a bare "fetch failed"', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), {
      code: 'ECONNREFUSED',
    });
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause });
    }) as unknown as typeof fetch;

    const err = await apiRequest(ENV, 'GET', '/api/v1/teams').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    const message = (err as Error).message;
    expect(message).toContain('GET http://gw.invalid:8080/api/v1/teams');
    expect(message).toContain('ECONNREFUSED');
    expect(message).not.toMatch(/^fetch failed$/);
  });

  it('prefixes the errno code when the cause message omits it', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' }),
      });
    }) as unknown as typeof fetch;
    const writes: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((s: string) => {
      writes.push(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runWithExitCodes(async () => {
        await apiRequest(ENV, 'GET', '/x');
        return 0;
      });
      expect(code).toBe(1);
    } finally {
      process.stderr.write = original;
    }
    expect(writes.join('')).toContain('ENOTFOUND getaddrinfo failed');
  });
});
