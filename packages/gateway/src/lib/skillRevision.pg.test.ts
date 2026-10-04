import { prisma } from '@auto-swe/shared/db';
import { syncBuiltins } from '@auto-swe/shared/lib/syncBuiltins';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Scanning has its own suite and would otherwise need the pattern table + a
// worker thread; revisions are what is under test here.
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ incomplete: false, safe: true, warnings: [] })),
}));

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

  beforeAll(async () => {
    await syncBuiltins(prisma);
  });
  afterAll(async () => {
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

  it('verifies only the revision the reviewer read', async () => {
    const skill = await fresh('reviewed');
    await updateSkill(prisma, skill, { promptText: 'changed under the reviewer' });
    await expect(verifySkill(prisma, skill)).rejects.toMatchObject({ code: 'P2025' });
    const live = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(live.isVerified).toBe(false);
    expect((await verifySkill(prisma, live)).isVerified).toBe(true);
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
