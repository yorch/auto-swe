import { prisma } from '@auto-swe/shared/db';
import { syncBuiltins } from '@auto-swe/shared/lib/syncBuiltins';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Scanning has its own suite and would otherwise need the pattern table + a
// worker thread; revisions are what is under test here.
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ incomplete: false, safe: true, warnings: [] })),
}));

import { skillsRoutes } from '../routes/skills.js';
import { createSkill, updateSkill, verifySkill } from './skillLibraryService.js';

/**
 * Skill revisions against real Postgres: the nested revision write, the
 * `(skill_id, revision)` unique index, the revision-guarded update that makes
 * two racing edits resolve to exactly one winner, and the idempotent backfill.
 * A mocked Prisma cannot show any of these.
 *
 * Opt in with `SKILL_REVISION_PG_TEST=1` and a `DATABASE_URL` that
 * `prisma migrate deploy` has been run against (it writes and deletes rows, so
 * use a throwaway one):
 *
 *   docker run -d --rm --name rev-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55501:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55501/t yarn workspace @auto-swe/shared db:deploy
 *   SKILL_REVISION_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/gateway/src/lib/skillRevision.pg.test.ts
 */
const enabled = process.env.SKILL_REVISION_PG_TEST === '1';

describe.skipIf(!enabled)('skill revisions against Postgres', () => {
  const created: string[] = [];
  const revisions = (skillId: string) =>
    prisma.skillRevision.findMany({ orderBy: { revision: 'asc' }, where: { skillId } });
  const fresh = async (promptText = 'v1') => {
    const { skill } = await createSkill(prisma, {
      description: 'd',
      name: `pg-skill-${Math.random().toString(36).slice(2)}`,
      promptText,
    });
    created.push(skill.id);
    return skill;
  };

  let app: FastifyInstance;
  const adminId = '00000000-0000-4000-a000-0000000000a1';
  const verifyViaRoute = (id: string, body: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer t' },
      method: 'POST',
      payload: body as never,
      url: `/api/v1/platform/skills/${id}/verify`,
    });

  beforeAll(async () => {
    await syncBuiltins(prisma);
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('prisma', prisma as unknown as never);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: adminId }),
    } as unknown as never);
    await app.register(skillsRoutes, { prefix: '/api/v1/platform' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await runUnscoped('test cleanup of the skills this suite created', ['Skill'], () =>
      prisma.skill.deleteMany({ where: { id: { in: created } } })
    );
    await prisma.$disconnect();
  });

  it('writes the skill and its revision 1 together', async () => {
    const skill = await fresh('hello');
    expect(skill.currentRevision).toBe(1);
    expect(await revisions(skill.id)).toEqual([
      expect.objectContaining({ promptText: 'hello', revision: 1 }),
    ]);
  });

  it('cuts revision 2 on an edit and leaves revision 1 verbatim', async () => {
    const skill = await fresh('first');
    const { updated } = await updateSkill(prisma, skill, { promptText: 'second' });
    expect(updated).toMatchObject({ currentRevision: 2, promptText: 'second' });
    expect((await revisions(skill.id)).map((r) => [r.revision, r.promptText])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
  });

  it('lets exactly one of two racing edits win; the loser leaves no revision behind', async () => {
    const skill = await fresh('base');
    const results = await Promise.allSettled([
      updateSkill(prisma, skill, { promptText: 'edit A' }),
      updateSkill(prisma, skill, { promptText: 'edit B' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as { code?: string }).code).toBe('P2025');
    const live = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    const rows = await revisions(skill.id);
    expect(live.currentRevision).toBe(2);
    expect(rows.map((r) => r.revision)).toEqual([1, 2]);
    // The live copy is exactly what revision 2 recorded.
    expect(rows[1]?.promptText).toBe(live.promptText);
  });

  it('refuses a duplicate (skill, revision) at the index', async () => {
    const skill = await fresh();
    await expect(
      prisma.skillRevision.create({
        data: { contentHash: 'x', promptText: 'dup', revision: 1, skillId: skill.id },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('guards the verify write on the revision it is given', async () => {
    const skill = await fresh('reviewed');
    await updateSkill(prisma, skill, { promptText: 'changed under the reviewer' });
    await expect(verifySkill(prisma, skill.id, 1)).rejects.toMatchObject({ code: 'P2025' });
    expect((await verifySkill(prisma, skill.id, 2)).isVerified).toBe(true);
  });

  it('verify through the route refuses a revision another admin has since replaced', async () => {
    // Admin A reads revision 1 in the UI; admin B edits; A clicks Verify.
    const skill = await fresh('reviewed text');
    await updateSkill(prisma, skill, { promptText: 'malicious text' });

    const stale = await verifyViaRoute(skill.id, { revision: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('SKILL_CHANGED');
    const after = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(after).toMatchObject({ isVerified: false, promptText: 'malicious text' });

    // A client that omits the revision is refused outright.
    expect((await verifyViaRoute(skill.id, {})).statusCode).toBe(400);
    // Verifying what is actually current works.
    expect((await verifyViaRoute(skill.id, { revision: 2 })).statusCode).toBe(200);
  });

  it('survives two replicas syncing the same changed built-in at once: one new revision, no throw', async () => {
    const def = await runUnscoped('test: pick a built-in', ['Skill'], () =>
      prisma.skill.findFirstOrThrow({ where: { isBuiltIn: true } })
    );
    // Simulate a release that changed this built-in's text: the stored copy is older.
    await prisma.skill.update({
      data: { promptText: 'stale text from last release' },
      where: { id: def.id },
    });
    const before = await prisma.skillRevision.count({ where: { skillId: def.id } });

    const results = await Promise.allSettled([syncBuiltins(prisma), syncBuiltins(prisma)]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await prisma.skillRevision.count({ where: { skillId: def.id } })).toBe(before + 1);
    const live = await prisma.skill.findUniqueOrThrow({ where: { id: def.id } });
    expect(live.promptText).not.toBe('stale text from last release');
  });

  it('deletes revisions with their skill', async () => {
    const skill = await fresh();
    await prisma.skill.delete({ where: { id: skill.id } });
    expect(await revisions(skill.id)).toEqual([]);
  });

  it('seeds every built-in with revision 1 and re-syncs without cutting more', async () => {
    const countBefore = await prisma.skillRevision.count();
    await syncBuiltins(prisma);
    expect(await prisma.skillRevision.count()).toBe(countBefore);
    const bare = await runUnscoped('test: every skill must have a revision', ['Skill'], () =>
      prisma.skill.findMany({ where: { revisions: { none: {} } } })
    );
    expect(bare).toEqual([]);
  });

  it('backfills a skill that has no revision row, once', async () => {
    const skill = await fresh('legacy');
    await prisma.skillRevision.deleteMany({ where: { skillId: skill.id } });
    await syncBuiltins(prisma);
    await syncBuiltins(prisma);
    expect(await revisions(skill.id)).toEqual([
      expect.objectContaining({ promptText: 'legacy', revision: 1 }),
    ]);
  });
});
