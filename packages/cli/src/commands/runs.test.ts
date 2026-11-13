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

  it('list shows the INITIATED BY column for each kind of initiator', async () => {
    const row = (overrides: Record<string, unknown>) => ({
      costUsdAccrued: 0,
      domain: null,
      endedAt: null,
      id: 'run-x',
      initiatedBy: null,
      initiatedByService: null,
      outcomeDomain: null,
      outcomeType: null,
      rerunOfRunId: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'SUCCESS',
      templateId: 't',
      templateVersion: 2,
      trigger: null,
      triggerRefId: null,
      workflowId: 'w',
      workRequest: null,
      ...overrides,
    });
    const rows = [
      row({
        id: 'run-person',
        initiatedBy: { email: 'ada@example.com', id: 'u1', name: 'Ada Lovelace' },
        trigger: 'template-run',
      }),
      row({
        id: 'run-no-name',
        initiatedBy: { email: 'jorge.barnaby@example.com', id: 'u2', name: null },
        trigger: 'template-run',
      }),
      row({
        id: 'run-service',
        initiatedByService: { id: 's1', name: 'ci-bot' },
        trigger: 'service-token',
      }),
      row({ id: 'run-schedule', trigger: 'schedule' }),
      row({ id: 'run-bare' }),
    ];
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: rows }),
        }) as unknown as Response
    ) as typeof fetch;

    const code = await runRunsCommand(['list'], ENV);
    expect(code).toBe(0);
    const lines = stdoutWrites.join('').split('\n');
    expect(lines[0]).toBe(
      `${'ID'.padEnd(38)}${'TICKET'.padEnd(18)}${'STATUS'.padEnd(12)}${'INITIATED BY'.padEnd(24)}${'TPLv'.padEnd(6)}STARTED`
    );
    const cells = (id: string) => lines.find((l) => l.startsWith(id)) ?? '';
    expect(cells('run-person')).toContain('SUCCESS'.padEnd(12) + 'Ada Lovelace'.padEnd(24));
    // 25 chars against a 24-wide column: 23 characters and an ellipsis, so it cannot pass for
    // a different complete address.
    expect(cells('run-no-name')).toContain(`${'SUCCESS'.padEnd(12)}jorge.barnaby@example.c…`);
    expect(cells('run-service')).toContain('ci-bot'.padEnd(24));
    expect(cells('run-schedule')).toContain('schedule'.padEnd(24));
    expect(cells('run-bare')).toContain('-'.padEnd(24));
  });

  it('list strips terminal escapes from names, emails and service names', async () => {
    const row = (id: string, overrides: Record<string, unknown>) => ({
      id,
      initiatedBy: null,
      initiatedByService: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'SUCCESS',
      templateVersion: 1,
      trigger: null,
      workRequest: null,
      ...overrides,
    });
    const rows = [
      row('run-ansi', {
        initiatedBy: { email: 'a@b.c', id: 'u1', name: '\u001b[1A\u001b[2Kevil' },
      }),
      row('run-osc', {
        initiatedBy: { email: 'a@b.c', id: 'u2', name: '\u001b]0;pwned\u0007x' },
      }),
      row('run-svc', { initiatedByService: { id: 's1', name: 'bot\u001b[31m' } }),
      row('run-mail', { initiatedBy: { email: 'e\u001b[1A@b.c', id: 'u3', name: null } }),
    ];
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: rows }),
        }) as unknown as Response
    ) as typeof fetch;

    const code = await runRunsCommand(['list'], ENV);
    expect(code).toBe(0);
    const out = stdoutWrites.join('');
    const controls = [...out].filter((c) => {
      const code = c.charCodeAt(0);
      return (code < 32 && c !== '\n') || code === 127;
    });
    expect(controls).toEqual([]);
  });

  it('show requires a runId', async () => {
    const code = await runRunsCommand(['show'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('Usage: runs show');
  });

  it('list rejects a filter flag passed without a value', async () => {
    const code = await runRunsCommand(['list', '--status'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('--status requires a value');
  });

  it('list rejects --limit=0', async () => {
    const code = await runRunsCommand(['list', '--limit=0'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('positive integer');
  });

  it('tail terminates on SUCCESS status', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
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
        }) as unknown as Response
    ) as typeof fetch;
    const code = await runRunsCommand(['tail', 'r-1', '--interval=1', '--max=1'], ENV);
    expect(code).toBe(0);
  });

  it('tail returns 2 on FAILED terminal status', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: { id: 'r-2', status: 'FAILED', steps: [] } }),
        }) as unknown as Response
    ) as typeof fetch;
    const code = await runRunsCommand(['tail', 'r-2', '--interval=1', '--max=1'], ENV);
    expect(code).toBe(2);
  });
});
