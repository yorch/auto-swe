import { createHash } from 'node:crypto';
import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import { signWebhookBody } from '@auto-swe/shared/lib/webhookSigning';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webhookRoutes } from './webhooks.js';

process.env.CONFIG_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

// `workflow.templateWebhookRequireSignature`, as the tests set it.
const policy = vi.hoisted(() => ({ ctx: [] as unknown[], requireSignature: false }));
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSetting: vi.fn(async (key: string, ctx: unknown) => {
    policy.ctx.push(ctx);
    return key === 'workflow.templateWebhookRequireSignature' ? policy.requireSignature : false;
  }),
}));

// Org spend comes from the mock's `orgMonthlyUsage` row (see test/billingMock.ts).
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

/**
 * `POST /api/v1/webhooks/:token` — the public, token-secured generic trigger.
 *
 * Its sender is an external system, which is exactly the caller most likely to
 * retry a delivery it never saw a response for. Without an `Idempotency-Key`
 * the workflow ID is random, so a retry silently starts a second run.
 */

const TEMPLATE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SHORT_TPL_ID = TEMPLATE_ID.replace(/-/g, '').slice(0, 8);
const TOKEN = 'tok_abcdef0123456789';

interface Harness {
  app: FastifyInstance;
  started: string[];
  startInputs: unknown[];
  order: string[];
  runInputs: Array<Record<string, unknown>>;
  activeWorkflows: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  connection: Record<string, unknown> | null;
  template: Record<string, unknown>;
  startError?: Error;
}

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

async function buildHarness(): Promise<Harness> {
  const h: Harness = {
    activeWorkflows: [],
    app: Fastify(),
    connection: null,
    decisions: [],
    order: [],
    runInputs: [],
    started: [],
    startInputs: [],
    template: {
      activeVersion: 2,
      id: TEMPLATE_ID,
      inputSchema: null,
      status: 'ACTIVE',
      team: {
        id: 'team-1',
        organization: { id: 'org-1', monthlyBudgetUsdCents: null },
        slug: 'platform',
      },
      teamId: 'team-1',
      workspaceProvider: 'api_only',
    },
  };

  h.app.setValidatorCompiler(validatorCompiler);
  h.app.setSerializerCompiler(serializerCompiler);
  await h.app.register(fastifyRawBody, { encoding: 'utf8', global: false, runFirst: true });

  const prismaMock: Record<string, unknown> = {
    activeWorkflow: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (h.activeWorkflows.some((a) => a.temporalWorkflowId === data.temporalWorkflowId)) {
          throw uniqueViolation();
        }
        const row = { id: `aw-${h.activeWorkflows.length + 1}`, ...data };
        h.activeWorkflows.push(row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        h.activeWorkflows = h.activeWorkflows.filter((a) => a.id !== where.id);
        return {};
      },
    },
    // The template's decision history.
    automationFire: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.decisions.push(data);
        return data;
      },
    },
    connection: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        h.connection && where.id === h.connection.id ? h.connection : null,
    },
    orgMonthlyUsage: {
      findUnique: async () => null,
    },
    runInput: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.runInputs.push(data);
        return data;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        h.runInputs = h.runInputs.filter((r) => r.id !== where.id);
        return {};
      },
    },
    workflowTemplate: {
      findUnique: async ({ where }: { where: { webhookToken?: string } }) =>
        where.webhookToken === TOKEN ? h.template : null,
    },
  };
  prismaMock.$queryRaw = async () => [];
  prismaMock.$executeRaw = async () => 1;
  prismaMock.$transaction = async (arg: unknown) => {
    h.order.push('ledger');
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    if (typeof arg === 'function') {
      return arg(prismaMock);
    }
    return undefined;
  };
  h.app.decorate('prisma', prismaMock as unknown as never);

  h.app.decorate('temporal', {
    signalWorkflow: async () => {},
    startRunnableWorkflow: async (id: string, input: unknown) => {
      h.order.push('start');
      if (h.startError) {
        throw h.startError;
      }
      h.started.push(id);
      h.startInputs.push(input);
    },
  } as unknown as never);

  h.app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
  await h.app.ready();
  return h;
}

function fire(h: Harness, key?: string) {
  return h.app.inject({
    headers: key ? { 'idempotency-key': key } : {},
    method: 'POST',
    payload: { description: 'nightly sweep' },
    url: `/api/v1/webhooks/${TOKEN}`,
  });
}

describe('POST /webhooks/:token', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  it('starts a run and writes the ledger first', async () => {
    const res = await fire(h);

    expect(res.statusCode).toBe(201);
    expect(h.order).toEqual(['ledger', 'start']);
  });

  it('records the call in the template’s decision history, refusals once an hour per reason', async () => {
    await fire(h);
    expect(h.decisions.at(-1)).toMatchObject({
      outcome: 'STARTED',
      source: 'template_webhook.call',
      subjectKey: TEMPLATE_ID,
    });
    h.template = { ...h.template, status: 'ARCHIVED' };
    await fire(h);
    await fire(h);
    const refusals = h.decisions.filter((d) => d.outcome === 'FAILED_TO_START');
    expect(refusals).toHaveLength(2);
    // Same owner, reason and hour: one key, so the database keeps one row.
    expect(refusals[0]?.dedupeKey).toBe(refusals[1]?.dedupeKey);
  });

  it('404s an unknown token without touching the ledger', async () => {
    const res = await h.app.inject({
      method: 'POST',
      payload: {},
      url: '/api/v1/webhooks/tok_wrong',
    });

    expect(res.statusCode).toBe(404);
    expect(h.runInputs).toHaveLength(0);
  });

  it('starts a distinct run per delivery when no Idempotency-Key is sent', async () => {
    await fire(h);
    await fire(h);
    expect(h.started).toHaveLength(2);
  });

  it('collapses a redelivered event with the same Idempotency-Key onto one run', async () => {
    const first = await fire(h, 'evt-1001');
    const second = await fire(h, 'evt-1001');

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(h.started).toHaveLength(1);
  });

  it('derives a stable workflow ID from the key', async () => {
    await fire(h, 'evt-1001');
    expect(h.started[0]).toMatch(new RegExp(`^wh-${SHORT_TPL_ID}-[0-9a-f]{16}$`));
  });

  it('keys are scoped per endpoint prefix, so a template-run key cannot alias a webhook run', async () => {
    await fire(h, 'shared-key');
    // Same key, different prefix — the `wh-` trigger must not collide with the
    // `wf-` template-run endpoint.
    expect(h.started[0].startsWith('wh-')).toBe(true);
  });

  it('rejects an over-long Idempotency-Key', async () => {
    const res = await fire(h, 'x'.repeat(256));
    expect(res.statusCode).toBe(400);
    expect(h.started).toHaveLength(0);
  });

  it('leaves no orphan ledger rows when the start fails', async () => {
    h.startError = new Error('temporal unreachable');

    await fire(h);

    expect(h.runInputs).toHaveLength(0);
    expect(h.activeWorkflows).toHaveLength(0);
  });

  it('passes the generic payload and connectionId through to the workflow', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    h.template = {
      ...h.template,
      team: {
        id: 'team-1',
        organization: { id: 'org-1', monthlyBudgetUsdCents: null },
        slug: 'platform',
      },
      teamId: 'team-1',
      workspaceProvider: 'document',
    };
    h.connection = {
      id: connectionId,
      isActive: true,
      team: {
        id: 'team-1',
        memberships: [],
        organization: { id: 'org-1', monthlyBudgetUsdCents: null },
      },
      teamId: 'team-1',
      type: 'notion',
    };

    const payload = {
      connectionId,
      message: 'hello',
      ticketId: 'WEB-1',
    };
    const res = await h.app.inject({
      method: 'POST',
      payload,
      url: `/api/v1/webhooks/${TOKEN}`,
    });

    expect(res.statusCode).toBe(201);
    expect(h.startInputs).toHaveLength(1);
    const input = h.startInputs[0] as { request: Record<string, unknown> };
    expect(input.request.connectionId).toBe(connectionId);
    expect(input.request.repoId).toBe(connectionId);
    expect(input.request.externalTicketId).toBe('WEB-1');
    expect(input.request.payload).toEqual(payload);
    expect(input.request.requestPayload).toBe(JSON.stringify(payload));
  });

  it('rejects an inactive connection', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    h.connection = {
      id: connectionId,
      isActive: false,
      team: { id: 'team-1', memberships: [], organization: { id: 'org-1' } },
      teamId: 'team-1',
      type: 'notion',
    };

    const res = await h.app.inject({
      method: 'POST',
      payload: { connectionId },
      url: `/api/v1/webhooks/${TOKEN}`,
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('CONNECTION_NOT_FOUND');
    expect(h.started).toHaveLength(0);
  });

  it('rejects a connection that does not belong to the template team', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    h.connection = {
      id: connectionId,
      isActive: true,
      team: { id: 'team-2', memberships: [], organization: { id: 'org-2' } },
      teamId: 'team-2',
      type: 'notion',
    };

    const res = await h.app.inject({
      method: 'POST',
      payload: { connectionId },
      url: `/api/v1/webhooks/${TOKEN}`,
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(h.started).toHaveLength(0);
  });

  it('rejects a connection type mismatch for the template provider', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    h.template = { ...h.template, workspaceProvider: 'document' };
    h.connection = {
      id: connectionId,
      isActive: true,
      team: { id: 'team-1', memberships: [], organization: { id: 'org-1' } },
      teamId: 'team-1',
      type: 'git_repo',
    };

    const res = await h.app.inject({
      method: 'POST',
      payload: { connectionId },
      url: `/api/v1/webhooks/${TOKEN}`,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('CONNECTION_TYPE_MISMATCH');
    expect(h.started).toHaveLength(0);
  });

  it('rejects the run when the org is over its monthly budget', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    h.template = { ...h.template, workspaceProvider: 'document' };
    h.connection = {
      id: connectionId,
      isActive: true,
      team: {
        id: 'team-1',
        memberships: [],
        organization: { id: 'org-1', monthlyBudgetUsdCents: 5000 },
      },
      teamId: 'team-1',
      type: 'notion',
    };
    const app = h.app as unknown as {
      prisma: { orgMonthlyUsage: { findUnique: () => Promise<unknown> } };
    };
    app.prisma.orgMonthlyUsage.findUnique = async () => ({ costUsdAccrued: 100 });

    const res = await h.app.inject({
      method: 'POST',
      payload: { connectionId },
      url: `/api/v1/webhooks/${TOKEN}`,
    });

    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('ORG_BUDGET_EXCEEDED');
    expect(h.started).toHaveLength(0);
  });
});

describe('POST /webhooks/:token — signatures', () => {
  let h: Harness;
  const SECRET = 'whsec_current_secret_for_tests';
  const OLD_SECRET = 'whsec_previous_secret_for_tests';

  /** Template columns for a sealed secret, as the rotate route writes them. */
  function sealed(prefix: 'webhookSigningSecret' | 'webhookPreviousSigningSecret', secret: string) {
    const s = encryptSecret(secret);
    return {
      [`${prefix}AuthTag`]: s.authTag,
      [`${prefix}Ciphertext`]: s.ciphertext,
      [`${prefix}KeyVersion`]: s.keyVersion,
      [`${prefix}LastFour`]: s.lastFour,
      [`${prefix}Nonce`]: s.nonce,
    };
  }

  // The exact bytes sent: signing is over the raw body, never re-serialised JSON.
  const BODY = '{"description":"nightly sweep",  "ticketId":"OPS-1"}';
  const nowSec = () => Math.floor(Date.now() / 1000);

  function send(headers: Record<string, string> = {}, body = BODY) {
    return h.app.inject({
      headers: { 'content-type': 'application/json', ...headers },
      method: 'POST',
      payload: body,
      url: `/api/v1/webhooks/${TOKEN}`,
    });
  }
  const signed = (secret: string, body = BODY, t = nowSec()) => ({
    'x-autoswe-signature': signWebhookBody(secret, body, t),
  });

  beforeEach(async () => {
    policy.requireSignature = false;
    policy.ctx = [];
    h = await buildHarness();
  });

  it('accepts an unsigned call when nothing requires signing (unchanged behaviour)', async () => {
    const res = await send();
    expect(res.statusCode).toBe(201);
  });

  it('accepts a correctly signed call when the template requires signing', async () => {
    h.template = {
      ...h.template,
      ...sealed('webhookSigningSecret', SECRET),
      webhookRequireSignature: true,
    };
    const res = await send(signed(SECRET));
    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['missing', {}],
    ['malformed', { 'x-autoswe-signature': 't=abc,v1=zz' }],
    ['stale', 'stale'],
    ['mismatch', 'wrong-secret'],
  ] as const)(
    'refuses a %s signature with 401 SIGNATURE_INVALID and records it',
    async (_label, how) => {
      h.template = {
        ...h.template,
        ...sealed('webhookSigningSecret', SECRET),
        webhookRequireSignature: true,
      };
      const headers =
        how === 'stale'
          ? signed(SECRET, BODY, nowSec() - 301)
          : how === 'wrong-secret'
            ? signed('whsec_not_the_secret')
            : how;
      const res = await send(headers);

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SIGNATURE_INVALID');
      expect(h.started).toHaveLength(0);
      expect(h.runInputs).toHaveLength(0);
      expect(h.decisions.at(-1)).toMatchObject({
        outcome: 'FAILED_TO_START',
        source: 'template_webhook.call',
        subjectKey: TEMPLATE_ID,
      });
      expect(String(h.decisions.at(-1)?.dedupeKey)).toContain(':SIGNATURE_INVALID:');
    }
  );

  it('refuses a tampered body even though the header is well formed', async () => {
    h.template = {
      ...h.template,
      ...sealed('webhookSigningSecret', SECRET),
      webhookRequireSignature: true,
    };
    const res = await send(signed(SECRET), BODY.replace('OPS-1', 'OPS-2'));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/does not match/);
  });

  it('verifies a signature against the raw bytes, not the re-serialised JSON', async () => {
    h.template = {
      ...h.template,
      ...sealed('webhookSigningSecret', SECRET),
      webhookRequireSignature: true,
    };
    const reserialised = JSON.stringify(JSON.parse(BODY));
    expect(reserialised).not.toBe(BODY);
    // Signed over the bytes actually sent (with their odd spacing): accepted.
    expect((await send(signed(SECRET))).statusCode).toBe(201);
    // Signed over a canonical form the sender did not send: refused.
    expect((await send(signed(SECRET, reserialised))).statusCode).toBe(401);
  });

  it('checks a signature that is present even when signing is optional', async () => {
    h.template = { ...h.template, ...sealed('webhookSigningSecret', SECRET) };
    expect((await send(signed('whsec_forged'))).statusCode).toBe(401);
    expect((await send(signed(SECRET))).statusCode).toBe(201);
    // And still accepts an unsigned call: signing is not required.
    expect((await send()).statusCode).toBe(201);
  });

  it('accepts the previous secret until it expires, then refuses it', async () => {
    h.template = {
      ...h.template,
      ...sealed('webhookSigningSecret', SECRET),
      ...sealed('webhookPreviousSigningSecret', OLD_SECRET),
      webhookPreviousSigningSecretExpiresAt: new Date(Date.now() + 60_000),
      webhookRequireSignature: true,
    };
    // Distinct timestamps: each is a distinct signed call, not a replay of the last.
    expect((await send(signed(OLD_SECRET, BODY, nowSec()))).statusCode).toBe(201);
    expect((await send(signed(SECRET, BODY, nowSec() - 1))).statusCode).toBe(201);

    h.template = { ...h.template, webhookPreviousSigningSecretExpiresAt: new Date(Date.now() - 1) };
    expect((await send(signed(OLD_SECRET, BODY, nowSec() - 2))).statusCode).toBe(401);
    expect((await send(signed(SECRET, BODY, nowSec() - 3))).statusCode).toBe(201);
  });

  it('enforces the policy setting, resolved with the template’s team and organization', async () => {
    policy.requireSignature = true;
    h.template = { ...h.template, ...sealed('webhookSigningSecret', SECRET) };

    expect((await send()).statusCode).toBe(401);
    expect(policy.ctx.at(-1)).toEqual({ orgId: 'org-1', teamId: 'team-1' });
    expect((await send(signed(SECRET))).statusCode).toBe(201);
  });

  it('refuses every call when signing is required but no secret is configured', async () => {
    policy.requireSignature = true;
    const res = await send(signed(SECRET));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('WEBHOOK_SIGNING_NOT_CONFIGURED');
    expect(h.started).toHaveLength(0);
    expect(String(h.decisions.at(-1)?.dedupeKey)).toContain(':WEBHOOK_SIGNING_NOT_CONFIGURED:');
  });

  it('binds a signed call to one run: a replay with a different Idempotency-Key is refused', async () => {
    h.template = {
      ...h.template,
      ...sealed('webhookSigningSecret', SECRET),
      webhookRequireSignature: true,
    };
    const headers = signed(SECRET);
    const first = await send({ ...headers, 'idempotency-key': 'first-key' });
    expect(first.statusCode).toBe(201);
    for (const key of ['another-key', undefined]) {
      const replay = await send({ ...headers, ...(key ? { 'idempotency-key': key } : {}) });
      expect(replay.statusCode).toBe(409);
      expect(replay.json().error.code).toBe('RUN_CONFLICT');
    }
    expect(h.started).toHaveLength(1);
    expect(h.decisions.at(-1)).toMatchObject({ outcome: 'SUPPRESSED_SAME_SUBJECT' });
    // A fresh signature (new timestamp) is a new call.
    const next = await send(signed(SECRET, BODY, nowSec() - 1));
    expect(next.statusCode).toBe(201);
  });

  it('an unsigned caller cannot squat the id a signed call will use', async () => {
    // Optional signing: unsigned calls are accepted, and the body of a cron sender is predictable.
    h.template = { ...h.template, ...sealed('webhookSigningSecret', SECRET) };
    const t = nowSec();
    const bodyHash = createHash('sha256').update(BODY).digest('hex');
    const squat = await send({ 'idempotency-key': `sig:${t}:${bodyHash}` });
    expect(squat.statusCode).toBe(201);
    const real = await send(signed(SECRET, BODY, t));
    expect(real.statusCode).toBe(201);
    expect(h.started).toHaveLength(2);
    expect(h.started[1]).toMatch(/^whs-/);
    expect(h.started[0]).toMatch(/^wh-/);
  });

  it('a signed call with an empty body verifies over the timestamp alone', async () => {
    h.template = {
      ...h.template,
      ...sealed('webhookSigningSecret', SECRET),
      webhookRequireSignature: true,
    };
    const ok = await h.app.inject({
      headers: { 'x-autoswe-signature': signWebhookBody(SECRET, '', nowSec()) },
      method: 'POST',
      url: `/api/v1/webhooks/${TOKEN}`,
    });
    expect(ok.statusCode).toBe(201);
    // A signature over a non-empty body does not verify an empty one.
    const bad = await h.app.inject({
      headers: { 'x-autoswe-signature': signWebhookBody(SECRET, '{}', nowSec() - 1) },
      method: 'POST',
      url: `/api/v1/webhooks/${TOKEN}`,
    });
    expect(bad.statusCode).toBe(401);
  });

  it('keeps the caller’s Idempotency-Key for an unsigned call', async () => {
    const a = await send({ 'idempotency-key': 'k1' });
    const b = await send({ 'idempotency-key': 'k1' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(409);
  });

  it('verifies over the exact bytes, including a BOM and invalid UTF-8 inside a string', async () => {
    h.template = {
      ...h.template,
      ...sealed('webhookSigningSecret', SECRET),
      webhookRequireSignature: true,
    };
    for (const bytes of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"description":"bom"}')]),
      Buffer.concat([
        Buffer.from('{"description":"'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"}'),
      ]),
    ]) {
      const res = await h.app.inject({
        headers: {
          'content-type': 'application/json',
          'x-autoswe-signature': signWebhookBody(SECRET, bytes, nowSec()),
        },
        method: 'POST',
        payload: bytes,
        url: `/api/v1/webhooks/${TOKEN}`,
      });
      expect(res.statusCode).toBe(201);
    }
  });

  it('still enforces the body limit while capturing the bytes', async () => {
    const big = JSON.stringify({ description: 'x'.repeat(130 * 1024) });
    const res = await h.app.inject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      payload: big,
      url: `/api/v1/webhooks/${TOKEN}`,
    });
    expect(res.statusCode).toBe(413);
    expect(h.started).toHaveLength(0);
  });

  it('checks the signature before saying anything else about the template', async () => {
    h.template = {
      ...h.template,
      ...sealed('webhookSigningSecret', SECRET),
      status: 'ARCHIVED',
      webhookRequireSignature: true,
    };
    const res = await send();
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SIGNATURE_INVALID');
  });
});
