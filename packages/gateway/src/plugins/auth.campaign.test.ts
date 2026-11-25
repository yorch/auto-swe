import { randomBytes } from 'node:crypto';
import { mintCampaignToken } from '@auto-swe/shared/lib/campaignTokenKey';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import { mintOrchestrationToken } from '@auto-swe/shared/lib/orchestrationTokenKey';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertServiceScopesAdmissible, rateLimitKey, requireAuth } from './auth.js';

/**
 * The campaign token on `requireAuth`: admitted only by a route that declares
 * `config.campaignToken`, only for the campaign and target its path names, and with no user behind
 * it. Driven against fake request/reply objects, as `auth.hook.test.ts` does.
 */

const CID = '0b1c2d3e-0000-4000-8000-000000000001';
const TID = '0b1c2d3e-0000-4000-8000-000000000002';
const OTHER = '0b1c2d3e-0000-4000-8000-000000000003';

const savedKey = process.env.CONFIG_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
});
afterAll(() => {
  if (savedKey === undefined) {
    delete process.env.CONFIG_ENCRYPTION_KEY;
  } else {
    process.env.CONFIG_ENCRYPTION_KEY = savedKey;
  }
  _resetKeyCacheForTests();
});

interface FakeReply {
  statusCode: number | undefined;
  body: unknown;
  status(code: number): FakeReply;
  send(body: unknown): FakeReply;
}
function makeReply(): FakeReply {
  const reply: FakeReply = {
    body: undefined,
    send(body: unknown) {
      reply.body = body;
      return reply;
    },
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    statusCode: undefined,
  };
  return reply;
}
function makeRequest(authorization: string, config: Record<string, unknown>, params: object) {
  return {
    headers: { authorization },
    ip: '10.0.0.1',
    log: { warn: vi.fn() },
    params,
    routeOptions: { config },
    server: { auth: {}, prisma: {} },
  } as unknown as FastifyRequest;
}
const code = (reply: FakeReply) => (reply.body as { error?: { code?: string } })?.error?.code;
const declared = { campaignToken: 'startAttempt' };
const token = () => mintCampaignToken({ call: 'startAttempt', campaignId: CID, targetId: TID });

describe('requireAuth — campaign token', () => {
  it('admits a token on the route that declares it, for its own campaign and target', async () => {
    const request = makeRequest(`Bearer ${token()}`, declared, { id: CID, targetId: TID });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);
    expect(reply.statusCode).toBeUndefined();
    expect(request.campaignCall).toEqual({ call: 'startAttempt', campaignId: CID, targetId: TID });
    expect(request.authMethod).toBe('campaign');
    // No identity: the route derives the launcher from the campaign's row.
    expect(request.user).toBeUndefined();
    expect(request.principal).toBeUndefined();
  });

  it('refuses it on a route that does not declare it', async () => {
    const request = makeRequest(`Bearer ${token()}`, {}, { id: CID, targetId: TID });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(403);
    expect(code(reply)).toBe('CAMPAIGN_TOKEN_NOT_ALLOWED');
    expect(request.campaignCall).toBeUndefined();
  });

  it('refuses it for another target or another campaign', async () => {
    for (const params of [
      { id: CID, targetId: OTHER },
      { id: OTHER, targetId: TID },
      { id: CID },
    ]) {
      const reply = makeReply();
      await requireAuth()(
        makeRequest(`Bearer ${token()}`, declared, params),
        reply as unknown as FastifyReply
      );
      expect(reply.statusCode).toBe(403);
      expect(code(reply)).toBe('CAMPAIGN_TOKEN_NOT_ALLOWED');
    }
  });

  it('refuses a forged or expired token with 401 and a fixed message', async () => {
    const forged = `${token().slice(0, -3)}AAA`;
    const stale = mintCampaignToken(
      { call: 'startAttempt', campaignId: CID, targetId: TID },
      60,
      Date.now() - 10 * 60_000
    );
    for (const bad of [forged, stale, 'camp_garbage']) {
      const reply = makeReply();
      await requireAuth()(
        makeRequest(`Bearer ${bad}`, declared, { id: CID, targetId: TID }),
        reply as unknown as FastifyReply
      );
      expect(reply.statusCode).toBe(401);
      expect(code(reply)).toBe('TOKEN_INVALID');
    }
  });

  it('never lets an orchestration token through as a campaign token', async () => {
    const orch = mintOrchestrationToken({ orchestrationId: CID });
    const reply = makeReply();
    const request = makeRequest(`Bearer ${orch}`, declared, { id: CID, targetId: TID });
    await requireAuth()(request, reply as unknown as FastifyReply).catch(() => undefined);
    expect(request.campaignCall).toBeUndefined();
  });

  it('buckets its rate limit on the campaign, and an invalid token on the address', () => {
    const ok = makeRequest(`Bearer ${token()}`, declared, {});
    expect(rateLimitKey(ok)).toBe(`camp:${CID}`);
    const bad = makeRequest('Bearer camp_garbage', declared, {});
    expect(rateLimitKey(bad)).not.toContain('camp:');
  });

  it('refuses at registration a campaign-token route that also names a capability', () => {
    expect(() =>
      assertServiceScopesAdmissible({
        config: { campaignToken: 'startAttempt' },
        onRequest: requireAuth({ handlerChecked: ['team.launch'] }),
        url: '/c',
      })
    ).toThrow(/campaign token/);
    expect(() =>
      assertServiceScopesAdmissible({
        config: { campaignToken: 'startAttempt' },
        onRequest: requireAuth(),
        url: '/c',
      })
    ).not.toThrow();
  });
});
