import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

vi.mock('./lib/time.js', () => ({ sleep: vi.fn(async () => undefined) }));

const REPO_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAN_ID = '660e8400-e29b-41d4-a716-446655440000';
const JOB = 'runplan-12345678-0123456789abcdef';

describe('top-level run dispatch', () => {
  let urls: string[];
  let origFetch: typeof globalThis.fetch;
  let origOut: typeof process.stdout.write;
  let origErr: typeof process.stderr.write;

  beforeEach(() => {
    urls = [];
    origFetch = globalThis.fetch;
    origOut = process.stdout.write;
    origErr = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    vi.stubEnv('AUTO_SWE_TOKEN', 'secret-token');
    vi.stubEnv('AUTO_SWE_API_URL', 'http://gw');
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      urls.push(`${init?.method} ${String(url)}`);
      const u = String(url);
      const body = u.endsWith('/run-plans')
        ? { data: { jobId: JOB } }
        : u.includes('/jobs/')
          ? { data: { planId: PLAN_ID, status: 'done' } }
          : {
              data: {
                createdAt: 'x',
                expiresAt: 'x',
                id: PLAN_ID,
                intent: 'g',
                mode: 'delivering',
                nodes: [],
                status: 'PENDING',
                warnings: [],
              },
            };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    vi.unstubAllEnvs();
  });

  it('sends run --describe to the plan path', async () => {
    expect(await main(['run', '--describe', 'Add health', `--repo=${REPO_ID}`])).toBe(0);
    expect(urls).toContain('POST http://gw/api/v1/run-plans');
    expect(urls.some((u) => u.includes('/work-requests'))).toBe(false);
  });

  it('keeps run without --describe on the work-request path', async () => {
    expect(await main(['run', `--repo=${REPO_ID}`])).toBe(1);
    expect(urls).toEqual([]);
  });
});
