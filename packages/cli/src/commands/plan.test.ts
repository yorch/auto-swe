import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeAlias, hasDescribeFlag, runDescribeAlias, runPlanCommand } from './plan.js';

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
    {
      id: 'v',
      inputs: [
        { from: 'context.ticket', hasDefault: true, key: 'ticket' },
        { from: 'request.description', hasDefault: false, key: 'goal' },
      ],
      marker: 'injected',
      region: 'pre',
      step: 'validate',
      type: 'step',
    },
    {
      agentRef: 'planner@2',
      feedsImplementer: true,
      id: 'r',
      inputs: [{ from: 'request.description', key: 'goal' }],
      marker: 'free',
      message: 'legacy\u001b[31m text',
      region: 'pre',
      step: null,
      type: 'agent',
      writes: ['context.planNotes'],
    },
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

  it('show prints a notice for a scrubbed plan, no outline, and exits 0', async () => {
    responder = () => ({
      body: {
        data: {
          approvedAt: '2026-08-01T00:00:00.000Z',
          cost: { totalUsd: 0.5 },
          expiresAt: '2026-08-01T01:00:00.000Z',
          id: PLAN_ID,
          intent: '',
          mode: 'delivering',
          model: 'anthropic/x',
          nodes: [],
          scrubbed: true,
          spec: null,
          status: 'LAUNCHED',
          warnings: [],
        },
      },
    });
    expect(await runPlanCommand(['show', PLAN_ID], ENV)).toBe(0);
    const text = stdout();
    expect(text).toContain(
      'The goal and plan body were removed from this plan record after the retention period. The run keeps its own records.'
    );
    expect(text).toContain('LAUNCHED');
    expect(text).toContain('$0.50');
    expect(text).not.toContain('Goal:');
    expect(text).not.toContain('Steps');
    expect(stderr()).toBe('');
  });

  it('list marks a scrubbed plan instead of printing an empty goal', async () => {
    responder = () => ({
      body: {
        data: [
          {
            id: PLAN_ID,
            intent: '',
            mode: 'delivering',
            scrubbed: true,
            status: 'LAUNCHED',
            totalUsd: 1,
          },
          {
            id: 'b',
            intent: 'live goal',
            mode: 'delivering',
            scrubbed: false,
            status: 'PENDING',
            totalUsd: 1,
          },
        ],
        meta: {},
      },
    });
    expect(await runPlanCommand(['list'], ENV)).toBe(0);
    const lines = stdout().trim().split('\n');
    expect(lines[0]).toContain(
      '(The goal and plan body were removed from this plan record after the retention period. The run keeps its own records)'
    );
    expect(lines[1]).toContain('live goal');
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
    expect(stdout()).toContain('runs agent planner@2 on the goal');
    expect(stdout()).toContain(
      'reads ticket from context.ticket (has fallback value), goal from the goal'
    );
    expect(stdout()).toContain('>> Output becomes guidance for the implementer');
    expect(stdout()).not.toContain('\u001b');
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

  it('approve --idempotency-key sends that key instead of a fresh one', async () => {
    responder = () => ({ body: { data: { planId: PLAN_ID, workRequestId: 'wr-1' } }, status: 201 });
    expect(
      await runPlanCommand(['approve', PLAN_ID, '--yes', '--idempotency-key=my-key-1'], ENV)
    ).toBe(0);
    expect(calls[0]?.headers['Idempotency-Key']).toBe('my-key-1');
  });

  it('approve says so when the key finds an earlier approval', async () => {
    responder = () => ({
      body: { data: { deduplicated: true, planId: PLAN_ID, workRequestId: 'wr-1' } },
    });
    expect(await runPlanCommand(['approve', PLAN_ID, '--yes', '--idempotency-key=k'], ENV)).toBe(0);
    expect(stdout()).toContain('already approved');
    expect(stdout()).toContain('wr-1');
  });

  it('approve refuses an empty or valueless --idempotency-key', async () => {
    expect(await runPlanCommand(['approve', PLAN_ID, '--yes', '--idempotency-key='], ENV)).toBe(1);
    expect(await runPlanCommand(['approve', PLAN_ID, '--yes', '--idempotency-key'], ENV)).toBe(1);
    expect(calls).toHaveLength(0);
  });

  describe('save', () => {
    it('saves the plan as a draft template and says it needs another reviewer', async () => {
      responder = () => ({
        body: { data: { name: 'My tpl', status: 'DRAFT', templateId: 'tpl-1', version: 1 } },
        status: 201,
      });
      expect(await runPlanCommand(['save', PLAN_ID, '--name=My tpl'], ENV)).toBe(0);
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.url).toContain(`/run-plans/${PLAN_ID}/save-as-template`);
      expect(calls[0]?.body).toEqual({ name: 'My tpl' });
      expect(stdout()).toContain('tpl-1');
      expect(stdout()).toContain('My tpl');
      expect(stdout()).toMatch(/DRAFT/);
      expect(stdout()).toMatch(/another person/);
    });

    it('sends no name when none is given', async () => {
      responder = () => ({
        body: { data: { name: 'x', status: 'DRAFT', templateId: 't', version: 1 } },
        status: 201,
      });
      expect(await runPlanCommand(['save', PLAN_ID], ENV)).toBe(0);
      expect(calls[0]?.body).toEqual({});
    });

    it('exits 2 with the gateway code on a refusal', async () => {
      responder = () => ({
        body: { error: { code: 'NAME_CONFLICT', message: 'A template named "x" already exists' } },
        status: 409,
      });
      expect(await runPlanCommand(['save', PLAN_ID, '--name=x'], ENV)).toBe(2);
      expect(stderr()).toContain('NAME_CONFLICT');
    });

    it('exits 2 for a caller below team lead', async () => {
      responder = () => ({
        body: { error: { code: 'FORBIDDEN', message: 'Requires LEAD membership' } },
        status: 403,
      });
      expect(await runPlanCommand(['save', PLAN_ID], ENV)).toBe(2);
      expect(stderr()).toContain('FORBIDDEN');
    });

    it('checks its arguments before calling the gateway', async () => {
      expect(await runPlanCommand(['save'], ENV)).toBe(1);
      expect(await runPlanCommand(['save', 'not-a-uuid'], ENV)).toBe(1);
      expect(await runPlanCommand(['save', PLAN_ID, '--name'], ENV)).toBe(1);
      expect(await runPlanCommand(['save', PLAN_ID, `--name=${'x'.repeat(121)}`], ENV)).toBe(1);
      expect(calls).toHaveLength(0);
    });
  });

  describe('run --describe alias', () => {
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

    it('maps the flag to plan run', () => {
      expect(describeAlias(['--describe', 'do it', '--repo=a/b', '--yes'])).toEqual([
        'run',
        'do it',
        '--repo=a/b',
        '--yes',
      ]);
      expect(describeAlias(['--repo=a/b', '--describe=do it'])).toEqual([
        'run',
        'do it',
        '--repo=a/b',
      ]);
      expect(describeAlias(['--describe'])).toEqual({ error: '--describe requires a value' });
      expect(describeAlias(['--describe', '--yes'])).toEqual({
        error: '--describe requires a value',
      });
      expect(describeAlias(['--describe=g', '--ticket=X-1'])).toHaveProperty('error');
      expect(hasDescribeFlag(['--describe', 'x'])).toBe(true);
      expect(hasDescribeFlag(['--describe=x'])).toBe(true);
      expect(hasDescribeFlag(['--description=x', '--ticket=T'])).toBe(false);
    });

    it('runs the same path as plan run, with the agent and the approval key', async () => {
      flow();
      expect(
        await runDescribeAlias(
          [
            '--describe',
            'Add health',
            `--repo=${REPO_ID}`,
            '--agent=docsMaintainer',
            '--idempotency-key=k1',
            '--yes',
          ],
          ENV
        )
      ).toBe(0);
      const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/run-plans'));
      expect(create?.body).toEqual({
        agent: 'docsMaintainer',
        intent: 'Add health',
        repoId: REPO_ID,
      });
      expect(create?.headers['Idempotency-Key']).toBe('k1');
      const approve = calls.at(-1);
      expect(approve?.url).toContain('/approve');
      expect(approve?.headers['Idempotency-Key']).toBe('k1');
    });

    it('without --yes stops after the plan', async () => {
      flow();
      expect(await runDescribeAlias(['--describe', 'g', `--repo=${REPO_ID}`], ENV)).toBe(0);
      expect(calls.some((c) => c.url.includes('/approve'))).toBe(false);
    });
  });

  it('run uses a fresh approval key without --idempotency-key', async () => {
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
    expect(await runPlanCommand(['run', 'g', `--repo=${REPO_ID}`, '--yes'], ENV)).toBe(0);
    expect(calls.at(-1)?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
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
