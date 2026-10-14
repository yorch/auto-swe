import { createHmac } from 'node:crypto';
import { signWebhookBody } from '@auto-swe/shared/lib/webhookSigning';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CONFIG_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString('base64');

const m = vi.hoisted(() => ({
  enabled: true as unknown,
  handle: vi.fn(),
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn(async () => m.enabled) }));
vi.mock('../lib/automations/inboundEvent.js', () => ({ handleInboundEvent: m.handle }));

import { AutomationStartError } from '../lib/automations/engine.js';
import { newSecretColumns } from '../lib/eventEndpoints.js';
import { inboundEventRoutes } from './inboundEvents.js';

const ID = '33333333-3333-4333-8333-333333333333';
const URL = `/api/v1/webhooks/events/${ID}`;
const SECRET = 'whsec_inbound_test_secret';

function row(over: Record<string, unknown> = {}) {
  return {
    ...newSecretColumns(SECRET).data,
    enabled: true,
    format: 'json',
    id: ID,
    idPointer: '/id',
    previousSecretAuthTag: null,
    previousSecretCiphertext: null,
    previousSecretExpiresAt: null,
    previousSecretKeyVersion: null,
    previousSecretNonce: null,
    scheme: 'autoswe-v1',
    scopePointer: null,
    signatureEncoding: null,
    signatureHeader: null,
    signaturePrefix: null,
    subjectPointer: null,
    team: {
      id: 'team-1',
      isActive: true,
      organization: { id: 'org-1', monthlyBudgetUsdCents: null },
      orgId: 'org-1',
    },
    teamId: 'team-1',
    timePointer: null,
    typePointer: '/type',
    ...over,
  };
}

async function build(endpoint: unknown = row()) {
  const app = Fastify();
  const findUnique = vi.fn(async () => endpoint);
  app.decorate('prisma', { eventEndpoint: { findUnique } } as never);
  await app.register(inboundEventRoutes, { prefix: '/api/v1/webhooks/events' });
  await app.ready();
  return { app, findUnique };
}

function signed(body: string, headers: Record<string, string> = {}) {
  return {
    headers: {
      'content-type': 'application/json',
      'x-autoswe-signature': signWebhookBody(SECRET, body, Math.floor(Date.now() / 1000)),
      ...headers,
    },
    method: 'POST' as const,
    payload: body,
    url: URL,
  };
}

const BODY = '{"type":"alert.fired","id":"e-1","secret":"do-not-store"}';

beforeEach(() => {
  m.enabled = true;
  m.handle.mockReset();
  m.handle.mockResolvedValue({ automationId: 'a', outcome: 'STARTED' });
});

describe('POST /api/v1/webhooks/events/:endpointId', () => {
  it('verifies, extracts and decides a signed event', async () => {
    const { app } = await build();
    const res = await app.inject(signed(BODY));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ data: { eventId: 'e-1', outcome: 'STARTED' } });
    const [, endpoint, event] = m.handle.mock.calls[0] ?? [];
    expect(endpoint).toMatchObject({ id: ID, teamId: 'team-1' });
    expect(event).toMatchObject({ endpointId: ID, id: 'e-1', type: 'alert.fired' });
  });

  it('drops a call the platform sent itself, before anything else, recording nothing', async () => {
    const { app, findUnique } = await build();
    const res = await app.inject({
      headers: { 'content-type': 'application/json', 'x-autoswe-delivery': 'd-1' },
      method: 'POST',
      payload: BODY,
      url: URL,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ data: { ignored: true } });
    expect(findUnique).not.toHaveBeenCalled();
    expect(m.handle).not.toHaveBeenCalled();
  });

  it('answers an unknown or malformed endpoint id with 404', async () => {
    const { app } = await build(null);
    expect((await app.inject(signed(BODY))).statusCode).toBe(404);
    const other = await build();
    const res = await other.app.inject({ ...signed(BODY), url: '/api/v1/webhooks/events/nope' });
    expect(res.statusCode).toBe(404);
    expect(other.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a bad signature with one fixed answer, whatever was wrong', async () => {
    const { app } = await build();
    const answers = await Promise.all([
      app.inject({ ...signed(BODY), payload: BODY.replace('fired', 'fixed') }),
      app.inject({ ...signed(BODY), headers: { 'content-type': 'application/json' } }),
      app.inject(
        signed(BODY, {
          'x-autoswe-signature': signWebhookBody(SECRET, BODY, Math.floor(Date.now() / 1000) - 900),
        })
      ),
    ]);
    for (const res of answers) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        error: { code: 'SIGNATURE_INVALID', message: 'The call is not signed for this endpoint' },
      });
    }
    expect(m.handle).not.toHaveBeenCalled();
  });

  it('checks the signature before saying the endpoint is disabled', async () => {
    const { app } = await build(row({ enabled: false }));
    expect((await app.inject({ ...signed(BODY), headers: {} })).statusCode).toBe(401);
    const res = await app.inject(signed(BODY));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EVENT_ENDPOINT_DISABLED');
  });

  it('refuses every event while the kill switch is off', async () => {
    m.enabled = false;
    const { app } = await build();
    const res = await app.inject(signed(BODY));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INBOUND_EVENTS_DISABLED');
    expect(m.handle).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON, and an event without a type', async () => {
    const { app } = await build();
    expect((await app.inject(signed('not json'))).statusCode).toBe(400);
    const res = await app.inject(signed('{"id":"x"}'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('EVENT_TYPE_MISSING');
  });

  it('refuses a body over the limit', async () => {
    const { app } = await build();
    const big = JSON.stringify({ pad: 'x'.repeat(130 * 1024), type: 't' });
    expect((await app.inject(signed(big))).statusCode).toBe(413);
  });

  it('verifies an HMAC over the exact bytes, whatever the content type', async () => {
    const { app } = await build(
      row({
        scheme: 'hmac-sha256',
        signatureEncoding: 'hex',
        signatureHeader: 'X-Hub-Signature-256',
        signaturePrefix: 'sha256=',
      })
    );
    // Whitespace a JSON parser would discard is part of what is signed.
    const body = '{ "type" : "push",\n "id": 7 }';
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    const res = await app.inject({
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` },
      method: 'POST',
      payload: body,
      url: URL,
    });
    expect(res.statusCode).toBe(202);
    expect(m.handle.mock.calls[0]?.[2]).toMatchObject({ id: '7', type: 'push' });
  });

  it('uses a digest of the body as the id of an event that names none', async () => {
    const { app } = await build(row({ idPointer: null }));
    await app.inject(signed('{"type":"t"}'));
    expect(m.handle.mock.calls[0]?.[2].id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('answers 503 when the run could not be started, so the sender retries', async () => {
    m.handle.mockRejectedValue(new AutomationStartError('down'));
    const { app } = await build();
    const res = await app.inject(signed(BODY));
    expect(res.statusCode).toBe(503);
  });

  it('says what became of an event without why', async () => {
    m.handle.mockResolvedValue({ duplicate: true });
    const { app } = await build();
    expect((await app.inject(signed(BODY))).json()).toEqual({
      data: { duplicate: true, eventId: 'e-1' },
    });
    m.handle.mockResolvedValue({ ignored: true, reason: 'no matching automation' });
    expect((await app.inject(signed(BODY))).json()).toEqual({
      data: { eventId: 'e-1', ignored: true },
    });
  });
});
