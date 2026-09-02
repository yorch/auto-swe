import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorkRequestsCommand } from './workRequests.js';

const ENV = { apiUrl: 'http://gw', token: 't' };

describe('runWorkRequestsCommand', () => {
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

  it('shows help on --help', async () => {
    const code = await runWorkRequestsCommand(['--help'], ENV);
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toContain('--ticket');
  });

  it('errors when --ticket is missing', async () => {
    const code = await runWorkRequestsCommand(['--description=foo', '--repo=org/repo'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('--ticket');
  });

  it('errors when --description is missing', async () => {
    const code = await runWorkRequestsCommand(['--ticket=T-1', '--repo=org/repo'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('--description');
  });

  it('errors when --repo is missing', async () => {
    const code = await runWorkRequestsCommand(['--ticket=T-1', '--description=foo'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('--repo');
  });

  it('rejects the unsupported --workflow flag instead of silently ignoring it', async () => {
    const code = await runWorkRequestsCommand(
      ['--ticket=T-1', '--description=foo', '--repo=org/repo', '--workflow=custom'],
      ENV
    );
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('workflows run');
  });

  it('errors when --repo format is invalid', async () => {
    const code = await runWorkRequestsCommand(
      ['--ticket=T-1', '--description=foo', '--repo=noslash'],
      ENV
    );
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('org/name');
  });

  it('errors when repo not found in gateway', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [] }),
    }) as unknown as typeof fetch;
    const code = await runWorkRequestsCommand(
      ['--ticket=T-1', '--description=foo', '--repo=org/repo'],
      ENV
    );
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('not found');
  });

  it('submits work request and prints confirmation', async () => {
    const reposPayload = JSON.stringify({
      data: [{ id: 'repo-1', isActive: true, organizationName: 'org', repoName: 'repo' }],
    });
    const teamsPayload = JSON.stringify({ data: [] });
    // Real POST /api/v1/work-requests response shape (201).
    const wrPayload = JSON.stringify({
      data: { workflowIds: ['wf-1'], workRequestId: 'wr-1' },
    });
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url as string);
      if ((url as string).includes('/repositories')) {
        return Promise.resolve({ ok: true, status: 200, text: async () => reposPayload });
      }
      if ((url as string).includes('/teams')) {
        return Promise.resolve({ ok: true, status: 200, text: async () => teamsPayload });
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => wrPayload });
    }) as unknown as typeof fetch;

    const code = await runWorkRequestsCommand(
      ['--ticket=T-1', '--description=foo', '--repo=org/repo'],
      ENV
    );
    expect(code).toBe(0);
    const out = stdoutWrites.join('');
    expect(out).toContain('Work request submitted');
    expect(out).toContain('wr-1');
    expect(out).toContain('wf-1');
    expect(out).not.toContain('undefined');
    expect(calls.some((u) => u.includes('/work-requests'))).toBe(true);
  });
});
