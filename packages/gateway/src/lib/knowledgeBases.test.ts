import type { FastifyInstance, FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  KnowledgeBaseOverridesSchema,
  storedKnowledgeBases,
  validateKnowledgeBaseOverrides,
} from './knowledgeBases.js';

const id = '11111111-1111-4111-8111-111111111111';
const target = { orgId: 'org', repoId: 'repo', teamId: 'team', templateId: 'template' };
function setup(rows: unknown[] = [], links: unknown[] = []) {
  const p = {
    knowledgeBase: { findMany: vi.fn().mockResolvedValue(rows) },
    knowledgeBaseLink: { findMany: vi.fn().mockResolvedValue(links) },
  };
  const reply = { send: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis() };
  return {
    p,
    reply,
    validate: (
      body?: Parameters<typeof validateKnowledgeBaseOverrides>[3],
      context: typeof target | undefined = target
    ) =>
      validateKnowledgeBaseOverrides(
        p as unknown as FastifyInstance['prisma'],
        reply as unknown as FastifyReply,
        context,
        body
      ),
  };
}
describe('run knowledge base overrides', () => {
  it('reads overrides for retries and tolerates absent or malformed legacy request payloads', () => {
    expect(storedKnowledgeBases(JSON.stringify({ knowledgeBases: { add: [{ id }] } }))).toEqual({
      add: [{ id }],
    });
    for (const payload of [
      null,
      '',
      'invalid',
      '{}',
      '{"knowledgeBases":{"add":[{"id":"invalid"}]}}',
    ]) {
      expect(storedKnowledgeBases(payload)).toBeUndefined();
    }
  });
  it('rejects overrides for a run without a team', async () => {
    const { p, reply } = setup();
    expect(
      await validateKnowledgeBaseOverrides(
        p as unknown as FastifyInstance['prisma'],
        reply as unknown as FastifyReply,
        undefined,
        {}
      )
    ).toBe(false);
    expect(reply.status).toHaveBeenCalledWith(400);
  });
  it('does no work when omitted', async () => {
    const { p, validate } = setup();
    expect(await validate()).toBeUndefined();
    expect(p.knowledgeBase.findMany).not.toHaveBeenCalled();
  });
  it('normalizes empty and additive overrides', async () => {
    expect(await setup().validate({})).toEqual({ add: [], exclude: [] });
    expect(await setup([{ id }]).validate({ add: [{ id, ref: 'v1' }] })).toEqual({
      add: [{ knowledgeBaseId: id, ref: 'v1' }],
      exclude: [],
    });
  });
  it('rejects unattachable ids without leaking which one', async () => {
    const { reply, validate, p } = setup();
    expect(await validate({ add: [{ id }] })).toBe(false);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(p.knowledgeBase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: 'org' }) })
    );
  });
  it('rejects attempts to exclude mandatory team defaults', async () => {
    const { validate, reply } = setup(
      [{ id }],
      [{ knowledgeBaseId: id, mandatory: true, scope: 'TEAM' }]
    );
    expect(await validate({ exclude: [id] })).toBe(false);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'KNOWLEDGE_BASE_MANDATORY' }),
      })
    );
  });
  it('validates all three attachability branches within the org', async () => {
    const { validate, p } = setup([{ id }]);
    await validate({ add: [{ id }, { id }] });
    expect(p.knowledgeBase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              OR: [
                { connection: { teamId: 'team' } },
                { visibility: 'ORG' },
                { shares: { some: { teamId: 'team' } }, visibility: 'SHARED' },
              ],
              orgId: 'org',
              status: 'OK',
            },
          ],
        }),
      })
    );
  });
  it('fails closed on database errors', async () => {
    const { p, validate } = setup();
    p.knowledgeBase.findMany.mockRejectedValue(new Error('offline'));
    await expect(validate({ add: [{ id }] })).rejects.toThrow('offline');
  });
  it('validates ids and unsafe refs at the launch boundary', () => {
    expect(KnowledgeBaseOverridesSchema.safeParse({ add: [{ id: 'bad' }] }).success).toBe(false);
    expect(KnowledgeBaseOverridesSchema.safeParse({ add: [{ id, ref: '-bad' }] }).success).toBe(
      false
    );
  });
});
