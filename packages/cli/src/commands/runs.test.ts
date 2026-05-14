import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRunsCommand } from './runs.js';

const ENV = { apiUrl: 'http://gw', token: 't' };

describe('runRunsCommand', () => {
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

  it('shows help on no subcommand', async () => {
    const code = await runRunsCommand([], ENV);
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toContain('auto-swe runs');
  });

  it('list builds the right query string with filters', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
      } as unknown as Response;
    }) as typeof fetch;
    const code = await runRunsCommand(['list', '--status=FAILED', '--limit=5'], ENV);
    expect(code).toBe(0);
    expect(capturedUrl).toContain('limit=5');
    expect(capturedUrl).toContain('status=FAILED');
  });

  it('show requires a runId', async () => {
    const code = await runRunsCommand(['show'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('Usage: runs show');
  });

  it('list rejects --limit=0', async () => {
    const code = await runRunsCommand(['list', '--limit=0'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('positive integer');
  });

  it('tail terminates on SUCCESS status', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              id: 'r-1',
              status: 'SUCCESS',
              steps: [{ nodeId: 'lint', status: 'PASSED' }],
            },
          }),
      } as unknown as Response;
    }) as typeof fetch;
    const code = await runRunsCommand(['tail', 'r-1', '--interval=1', '--max=1'], ENV);
    expect(code).toBe(0);
  });

  it('tail returns 2 on FAILED terminal status', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { id: 'r-2', status: 'FAILED', steps: [] } }),
      } as unknown as Response;
    }) as typeof fetch;
    const code = await runRunsCommand(['tail', 'r-2', '--interval=1', '--max=1'], ENV);
    expect(code).toBe(2);
  });
});
