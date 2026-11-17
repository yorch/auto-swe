import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlanCommand } from './plan.js';

vi.mock('../lib/time.js', () => ({ sleep: vi.fn(async () => undefined) }));

const ENV = { apiUrl: 'http://gw', token: 'secret-token' };
const REPO_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAN_ID = '660e8400-e29b-41d4-a716-446655440000';
const JOB = 'runplan-12345678-0123456789abcdef';

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

const PLAN = {
  agentPins: { implementer: 3 },
  cost: {
    exclusions: 'Agent steps are not priced.',
    totalUsd: 0.5,
    unpriced: [{ nodeId: 'impl' }],
  },
  expiresAt: '2026-11-18T00:00:00.000Z',
  id: PLAN_ID,
  intent: 'Add health',
  mode: 'delivering',
  nodes: [
    { id: 'impl', marker: 'core', region: 'core', step: 'executeImplementation', type: 'step' },
    { id: 'v', marker: 'injected', region: 'pre', step: 'validate', type: 'step' },
  ],
  spec: { nodes: { SECRET_SPEC_MARKER: {} } },
  status: 'PENDING',
  warnings: [{ code: 'W1', message: 'careful', nodeId: 'impl' }],
};

describe('auto-swe plan', () => {
  let out: string[];
  let err: string[];
  let calls: Call[];
  let responder: (c: Call) => { status?: number; body: unknown };
  let origOut: typeof process.stdout.write;
  let origErr: typeof process.stderr.write;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    out = [];
    err = [];
    calls = [];
    origOut = process.stdout.write;
    origErr = process.stderr.write;
    origFetch = globalThis.fetch;
    process.stdout.write = ((s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      err.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    responder = () => ({ body: {} });
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const call: Call = {
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
        method: String(init?.method),
        url: String(url),
      };
      calls.push(call);
      const r = responder(call);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    globalThis.fetch = origFetch;
  });

  const stdout = () => out.join('');
  const stderr = () => err.join('');

  it('route prints ranked templates and the generate hint', async () => {
    responder = () => ({
      body: {
        data: {
          matches: [{ name: 'Docs fix', reason: 'close', score: 0.9, templateId: 't' }],
          noneFit: false,
        },
      },
    });
    expect(await runPlanCommand(['route', 'fix docs', `--repo=${REPO_ID}`], ENV)).toBe(0);
    expect(calls[0]?.body).toEqual({ intent: 'fix docs', repoId: REPO_ID });
    expect(stdout()).toContain('Docs fix');
    expect(stdout()).toContain('plan create');
  });

  it('route says nothing fits on an empty match list', async () => {
    responder = () => ({ body: { data: { matches: [], noneFit: true } } });
    expect(await runPlanCommand(['route', 'x', `--repo=${REPO_ID}`], ENV)).toBe(0);
    expect(stdout()).toContain('No existing template fits');
  });

  it('create --wait polls to done and prints the plan id', async () => {
    let polls = 0;
    responder = (c) => {
      if (c.method === 'POST') {
        return { body: { data: { jobId: JOB } }, status: 202 };
      }
      polls++;
      return {
        body: { data: polls < 3 ? { status: 'running' } : { planId: PLAN_ID, status: 'done' } },
      };
    };
    expect(
      await runPlanCommand(
        ['create', 'Add health', `--repo=${REPO_ID}`, '--agent=docsMaintainer', '--wait'],
        ENV
      )
    ).toBe(0);
    expect(calls[0]?.body).toEqual({
      agent: 'docsMaintainer',
      intent: 'Add health',
      repoId: REPO_ID,
    });
    expect(polls).toBe(3);
    expect(stdout()).toContain(`Plan ready: ${PLAN_ID}`);
  });

  it('create without --wait prints the job and the wait command', async () => {
    responder = () => ({ body: { data: { jobId: JOB } }, status: 202 });
    expect(await runPlanCommand(['create', 'g', `--repo=${REPO_ID}`], ENV)).toBe(0);
    expect(stdout()).toContain(`plan wait ${JOB}`);
    expect(calls).toHaveLength(1);
  });

  it('a failed job exits 2 with the stable error code', async () => {
    responder = (c) =>
      c.method === 'POST'
        ? { body: { data: { jobId: JOB } }, status: 202 }
        : {
            body: {
              data: {
                code: 'PLAN_GENERATION_FAILED',
                message: 'Try rephrasing.',
                retryable: true,
                status: 'failed',
              },
            },
          };
    expect(await runPlanCommand(['create', 'g', `--repo=${REPO_ID}`, '--wait'], ENV)).toBe(2);
    expect(stderr()).toContain('PLAN_GENERATION_FAILED: Try rephrasing.');
  });

  it('a polling timeout exits 1 and names plan wait', async () => {
    responder = (c) =>
      c.method === 'POST'
        ? { body: { data: { jobId: JOB } }, status: 202 }
        : { body: { data: { status: 'running' } } };
    expect(
      await runPlanCommand(['create', 'g', `--repo=${REPO_ID}`, '--wait', '--timeout=5'], ENV)
    ).toBe(1);
    expect(stderr()).toContain(`plan wait ${JOB}`);
  });

  it('show prints an outline and never the spec; --json prints it', async () => {
    responder = () => ({ body: { data: PLAN } });
    expect(await runPlanCommand(['show', PLAN_ID], ENV)).toBe(0);
    const text = stdout();
    expect(text).toContain('[core');
    expect(text).toContain('[injected');
    expect(text).toContain('$0.50');
    expect(text).toContain('Not priced (1): impl');
    expect(text).toContain('W1');
    expect(text).toContain('implementer @ 3');
    expect(text).not.toContain('SECRET_SPEC_MARKER');
    out.length = 0;
    expect(await runPlanCommand(['show', PLAN_ID, '--json'], ENV)).toBe(0);
    expect(stdout()).toContain('SECRET_SPEC_MARKER');
  });

  it('never sends the token anywhere but the header', async () => {
    responder = () => ({ body: { data: PLAN } });
    await runPlanCommand(['show', PLAN_ID], ENV);
    expect(stdout() + stderr()).not.toContain('secret-token');
  });

  it('list passes the status filter', async () => {
    responder = () => ({
      body: {
        data: [{ id: PLAN_ID, intent: 'g', mode: 'delivering', status: 'PENDING', totalUsd: 1 }],
        meta: {},
      },
    });
    expect(await runPlanCommand(['list', '--status=pending', '--limit=5'], ENV)).toBe(0);
    expect(calls[0]?.url).toContain('status=PENDING');
    expect(calls[0]?.url).toContain('limit=5');
    expect(stdout()).toContain(PLAN_ID);
  });

  it('approve refuses non-interactively without --yes and calls nothing', async () => {
    expect(await runPlanCommand(['approve', PLAN_ID], ENV, { interactive: false })).toBe(1);
    expect(stderr()).toContain('non-interactive');
    expect(calls).toHaveLength(0);
  });

  it('approve --yes sends an idempotency key and the budget tier', async () => {
    responder = () => ({ body: { data: { planId: PLAN_ID, workRequestId: 'wr-1' } }, status: 201 });
    expect(
      await runPlanCommand(['approve', PLAN_ID, '--yes', '--budget-tier=large'], ENV, {
        interactive: false,
      })
    ).toBe(0);
    expect(calls[0]?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]?.body).toEqual({ budgetTier: 'LARGE' });
    expect(stdout()).toContain('wr-1');
  });

  it('approve interactively shows the plan and confirms', async () => {
    responder = (c) =>
      c.method === 'GET'
        ? { body: { data: PLAN } }
        : { body: { data: { planId: PLAN_ID, workRequestId: 'wr-1' } }, status: 201 };
    const confirm = vi.fn(async () => true);
    expect(await runPlanCommand(['approve', PLAN_ID], ENV, { confirm, interactive: true })).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(stdout()).toContain('Steps');
    expect(calls.at(-1)?.method).toBe('POST');
  });

  it('approve declined sends nothing', async () => {
    responder = () => ({ body: { data: PLAN } });
    const confirm = vi.fn(async () => false);
    expect(await runPlanCommand(['approve', PLAN_ID], ENV, { confirm, interactive: true })).toBe(1);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('maps a drift 409 to a regenerate message', async () => {
    responder = () => ({
      body: {
        error: { code: 'PLAN_CATALOG_CHANGED', details: { drift: 'catalog' }, message: 'changed' },
      },
      status: 409,
    });
    expect(await runPlanCommand(['approve', PLAN_ID, '--yes'], ENV)).toBe(2);
    expect(stderr()).toContain('PLAN_CATALOG_CHANGED');
    expect(stderr()).toContain('Generate a new plan');
    expect(stderr()).toContain('catalog changed');
  });

  it('rejects a plan', async () => {
    responder = () => ({ body: { data: { planId: PLAN_ID, status: 'REJECTED' } } });
    expect(await runPlanCommand(['reject', PLAN_ID], ENV)).toBe(0);
    expect(calls[0]?.url).toContain(`/run-plans/${PLAN_ID}/reject`);
  });

  describe('run', () => {
    const flow = () => {
      responder = (c) => {
        if (c.method === 'POST' && c.url.endsWith('/run-plans')) {
          return { body: { data: { jobId: JOB } }, status: 202 };
        }
        if (c.url.includes('/jobs/')) {
          return { body: { data: { planId: PLAN_ID, status: 'done' } } };
        }
        if (c.method === 'GET') {
          return { body: { data: PLAN } };
        }
        return { body: { data: { planId: PLAN_ID, workRequestId: 'wr-1' } }, status: 201 };
      };
    };

    it('with --yes creates, waits, shows and approves', async () => {
      flow();
      expect(await runPlanCommand(['run', 'g', `--repo=${REPO_ID}`, '--yes'], ENV)).toBe(0);
      expect(calls.at(-1)?.url).toContain('/approve');
      expect(stdout()).toContain('Steps');
      expect(stdout()).not.toContain('SECRET_SPEC_MARKER');
    });

    it('without --yes stops after the plan and names the approve command', async () => {
      flow();
      expect(await runPlanCommand(['run', 'g', `--repo=${REPO_ID}`], ENV)).toBe(0);
      expect(calls.some((c) => c.url.includes('/approve'))).toBe(false);
      expect(stdout()).toContain(`plan approve ${PLAN_ID}`);
    });
  });

  it('requires a goal and a repository', async () => {
    expect(await runPlanCommand(['create'], ENV)).toBe(1);
    expect(await runPlanCommand(['create', 'g'], ENV)).toBe(1);
    expect(stderr()).toContain('--repo');
  });

  it('rejects an unknown subcommand', async () => {
    expect(await runPlanCommand(['bogus'], ENV)).toBe(1);
  });
});
