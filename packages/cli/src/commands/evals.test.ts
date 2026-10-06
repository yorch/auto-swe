import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evalRunExitCode, runEvalsCommand } from './evals.js';

const ENV = { apiUrl: 'http://gw', token: 't' };

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('runEvalsCommand', () => {
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
    vi.useRealTimers();
  });

  it('shows help on no subcommand', async () => {
    const code = await runEvalsCommand([], ENV);
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toContain('auto-swe evals');
  });

  it('list prints one line per dataset from the unwrapped envelope', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            caseCount: 3,
            createdAt: '2026-01-01T00:00:00.000Z',
            description: null,
            id: 'ds-1',
            name: 'Golden set',
            scope: 'GLOBAL',
            slug: 'golden',
          },
        ],
      })
    ) as typeof fetch;
    const code = await runEvalsCommand(['list'], ENV);
    expect(code).toBe(0);
    const out = stdoutWrites.join('');
    expect(out).toContain('ds-1  golden  [GLOBAL]  3 cases');
    expect(out).not.toContain('undefined');
  });

  it('list reports an empty catalogue', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [] })) as typeof fetch;
    const code = await runEvalsCommand(['list'], ENV);
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toContain('No eval datasets.');
  });

  it('show requires an id', async () => {
    const code = await runEvalsCommand(['show'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('Usage: evals show');
  });

  it('show prints the dataset and its cases', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: {
          caseCount: 1,
          cases: [
            {
              baselineSha: 'abcdef0123456789',
              flakeScreened: true,
              id: 'case-1',
              repoUrl: 'https://github.com/acme/api',
            },
          ],
          createdAt: '2026-01-01T00:00:00.000Z',
          description: null,
          id: 'ds-1',
          name: 'Golden set',
          scope: 'GLOBAL',
          slug: 'golden',
        },
      })
    ) as typeof fetch;
    const code = await runEvalsCommand(['show', 'ds-1'], ENV);
    expect(code).toBe(0);
    const out = stdoutWrites.join('');
    expect(out).toContain('Golden set (golden) — 1 cases');
    expect(out).toContain('case-1  https://github.com/acme/api@abcdef0123  ✓screened');
  });

  it('results builds the query string and reads meta.total from the full envelope', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return jsonResponse({
        data: [
          {
            createdAt: '2026-01-01T00:00:00.000Z',
            runtime: 'claude-code',
            scorer: 'tests-pass',
            scoreType: 'BOOLEAN',
            source: 'GATE',
            value: 1,
          },
          {
            createdAt: '2026-01-01T00:00:01.000Z',
            scorer: 'judge',
            scoreType: 'NUMERIC',
            source: 'REVIEW',
            value: 0.75,
          },
        ],
        meta: { limit: 10, offset: 0, total: 42 },
      });
    }) as typeof fetch;
    const code = await runEvalsCommand(
      ['results', '--run=run-1', '--source=GATE', '--scorer=tests-pass', '--limit=10'],
      ENV
    );
    expect(code).toBe(0);
    expect(capturedUrl).toContain('runId=run-1');
    expect(capturedUrl).toContain('source=GATE');
    expect(capturedUrl).toContain('scorer=tests-pass');
    expect(capturedUrl).toContain('limit=10');
    const out = stdoutWrites.join('');
    expect(out).toContain('pass');
    expect(out).toContain('0.75');
    expect(out).toContain('pass  claude-code');
    expect(out).toContain('(2 of 42)');
  });

  it('run requires a slug and both refs', async () => {
    const code = await runEvalsCommand(['run', 'golden', '--candidate=abc'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('Usage: evals run');
  });

  it('run resolves the slug, starts the run, and exits 1 on REGRESSION', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url });
      if (url.endsWith('/api/v1/platform/evals')) {
        return jsonResponse({
          data: [{ caseCount: 1, id: 'ds-1', name: 'Golden', scope: 'GLOBAL', slug: 'golden' }],
        });
      }
      if (url.endsWith('/api/v1/platform/evals/runs')) {
        return jsonResponse({ data: { id: 'run-9', status: 'RUNNING', summary: null } });
      }
      return jsonResponse({
        data: { id: 'run-9', status: 'REGRESSION', summary: { summary: '2 cases regressed' } },
      });
    }) as typeof fetch;
    const code = await runEvalsCommand(
      ['run', 'golden', '--candidate=feat', '--against=main'],
      ENV
    );
    expect(code).toBe(1);
    const started = calls.find((c) => c.url.endsWith('/evals/runs'));
    expect(started?.method).toBe('POST');
    expect(stdoutWrites.join('')).toContain('Started eval run run-9');
    expect(stdoutWrites.join('')).toContain('2 cases regressed');
  });

  function runFetch(finalStatus: string, summary: unknown = null) {
    return vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/platform/evals')) {
        return jsonResponse({
          data: [{ caseCount: 1, id: 'ds-1', name: 'Golden', scope: 'GLOBAL', slug: 'golden' }],
        });
      }
      if (url.endsWith('/api/v1/platform/evals/runs')) {
        return jsonResponse({ data: { id: 'run-9', status: 'RUNNING', summary: null } });
      }
      return jsonResponse({ data: { id: 'run-9', status: finalStatus, summary } });
    }) as unknown as typeof fetch;
  }

  it('run sends a per-side runtime override and prints the runtimes that ran', async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/platform/evals')) {
        return jsonResponse({
          data: [{ caseCount: 1, id: 'ds-1', name: 'Golden', scope: 'GLOBAL', slug: 'golden' }],
        });
      }
      if (url.endsWith('/api/v1/platform/evals/runs')) {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ data: { id: 'run-9', status: 'RUNNING', summary: null } });
      }
      return jsonResponse({
        data: {
          id: 'run-9',
          status: 'SUCCESS',
          summary: {
            runtimes: { baseline: ['mastra'], candidate: ['claude-code'] },
            summary: 'no significant regression',
          },
        },
      });
    }) as unknown as typeof fetch;
    const code = await runEvalsCommand(
      [
        'run',
        'golden',
        '--candidate=implementer@3',
        '--against=implementer@3',
        '--candidate-runtime=claude-code',
        '--against-runtime=mastra',
      ],
      ENV
    );
    expect(code).toBe(0);
    expect(body).toMatchObject({ baselineRuntime: 'mastra', candidateRuntime: 'claude-code' });
    const out = stdoutWrites.join('');
    expect(out).toContain('implementer@3 on claude-code vs implementer@3 on mastra');
    expect(out).toContain('Runtimes: candidate claude-code, baseline mastra');
  });

  it('run sends no runtime when no flag names one', async () => {
    let body: Record<string, unknown> = {};
    const inner = runFetch('SUCCESS', { summary: 'ok' });
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/platform/evals/runs')) {
        body = JSON.parse(String(init?.body));
      }
      return (inner as unknown as (u: string) => Promise<Response>)(url);
    }) as unknown as typeof fetch;
    await runEvalsCommand(['run', 'golden', '--candidate=feat', '--against=main'], ENV);
    expect(body).not.toHaveProperty('candidateRuntime');
    expect(body).not.toHaveProperty('baselineRuntime');
  });

  it('run refuses an unknown runtime before calling the gateway', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const code = await runEvalsCommand(
      ['run', 'golden', '--candidate=feat', '--against=main', '--candidate-runtime=codex'],
      ENV
    );
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain(
      '--candidate-runtime must be one of mastra, claude-code'
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('run exits 0 only on SUCCESS', async () => {
    globalThis.fetch = runFetch('SUCCESS', { summary: 'no significant regression' });
    const code = await runEvalsCommand(
      ['run', 'golden', '--candidate=feat', '--against=main'],
      ENV
    );
    expect(code).toBe(0);
  });

  it('run exits non-zero when the eval run FAILED without a verdict', async () => {
    globalThis.fetch = runFetch('FAILED');
    const code = await runEvalsCommand(
      ['run', 'golden', '--candidate=feat', '--against=main'],
      ENV
    );
    expect(code).toBe(2);
    expect(stdoutWrites.join('')).toContain('FAILED');
  });

  it('run exits 2 and says so when the budget stopped a SUCCESS run part-way', async () => {
    globalThis.fetch = runFetch('SUCCESS', {
      partial: {
        completedCases: 1,
        error: 'Runless token budget exceeded',
        notRunCaseIds: ['c2'],
        reason: 'budget',
        totalCases: 50,
      },
      summary: 'no significant regression',
    });
    const code = await runEvalsCommand(
      ['run', 'golden', '--candidate=feat', '--against=main'],
      ENV
    );
    expect(code).toBe(2);
    expect(stdoutWrites.join('')).toContain(
      'Partial verdict: 1 of 50 cases ran — Runless token budget exceeded'
    );
  });

  it('evalRunExitCode treats a partial verdict as no pass, and a partial regression as one', () => {
    expect(evalRunExitCode('SUCCESS', true)).toBe(2);
    expect(evalRunExitCode('REGRESSION', true)).toBe(1);
  });

  it('evalRunExitCode treats every status but SUCCESS as a failed gate', () => {
    expect(evalRunExitCode('SUCCESS')).toBe(0);
    expect(evalRunExitCode('REGRESSION')).toBe(1);
    expect(evalRunExitCode('FAILED')).toBe(2);
    expect(evalRunExitCode('CANCELLED')).toBe(2);
  });

  it('run fails with a clear message when the slug is unknown', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [] })) as typeof fetch;
    const code = await runEvalsCommand(
      ['run', 'missing', '--candidate=feat', '--against=main'],
      ENV
    );
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain("No dataset with slug 'missing'");
  });

  it('maps a gateway error to exit 2', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { code: 'FORBIDDEN', message: 'admin only' } }),
    })) as unknown as typeof fetch;
    const code = await runEvalsCommand(['list'], ENV);
    expect(code).toBe(2);
    expect(stderrWrites.join('')).toContain('FORBIDDEN: admin only');
  });
});
