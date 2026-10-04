import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const SHA = 'c'.repeat(40);
const NEW_SHA = 'd'.repeat(40);
const { fetchSkillSource, scanSkillContent } = vi.hoisted(() => ({
  fetchSkillSource: vi.fn(),
  scanSkillContent: vi.fn(async (_text: string, _opts?: unknown) => ({
    incomplete: false,
    safe: true,
    warnings: [] as string[],
  })),
}));
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({ scanSkillContent }));
vi.mock('@auto-swe/shared/lib/skillSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/skillSource')>()),
  fetchSkillSource,
}));

import { skillSourceRoutes } from '../routes/skillSources.js';
import { updateSkill } from './skillLibraryService.js';
import { installSkillSource } from './skillSourceService.js';

/**
 * Whether a skill's diff is complete depends only on that skill's own text, never
 * on how much work the other skills' diffs took. Opt in with
 * `SKILL_SOURCE_PG_TEST=1` and a migrated throwaway `DATABASE_URL`, as for
 * `skillSource.pg.test.ts`.
 */
const enabled = process.env.SKILL_SOURCE_PG_TEST === '1';
const rnd = () => Math.random().toString(36).slice(2, 10);
// Each costs far more than a skill's work budget on its own.
const heavyOld = Array.from({ length: 12000 }, (_, i) => (i % 2 ? 'a' : 'b')).join('\n');
const heavyNew = Array.from({ length: 12000 }, (_, i) => (i % 3 ? 'a' : 'b')).join('\n');

describe.skipIf(!enabled)('the diff budget is per skill (Postgres)', () => {
  let app: FastifyInstance;
  let userId: string;
  const tag = rnd();
  const names: string[] = [];

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { email: `bud-${tag}@example.test` } })).id;
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('prisma', prisma as unknown as never);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: userId }),
    } as unknown as never);
    await app.register(skillSourceRoutes, { prefix: '/api/v1/platform' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await runUnscoped('cleanup', ['Skill'], () =>
      prisma.skill.deleteMany({ where: { name: { in: names } } })
    );
    await runUnscoped('cleanup', ['SkillSource'], () =>
      prisma.skillSource.deleteMany({ where: { owner: `o-${tag}` } })
    );
    await prisma.configAuditLog.deleteMany({ where: { actorId: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const sk = (name: string, text: string) => ({
    description: `${name} d`,
    errors: [],
    folder: `skills/${name}`,
    ignoredKeys: [],
    name,
    promptText: text,
    referenceFiles: [],
    skippedFiles: [],
  });
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer t' },
      method,
      payload: payload as never,
      url: `/api/v1/platform/skill-sources${url}`,
    });

  it('a small skill is complete beside fifteen heavy ones, and an oversized one stays refused whatever the others do', async () => {
    const heavy = Array.from({ length: 15 }, (_, i) => `h${String(i).padStart(2, '0')}-${tag}`);
    const small = `s-${tag}`; // sorts after the heavy ones: it used to inherit a spent budget
    const big = `z-${tag}`; // a rewrite past the edit cap on its own
    const bigOld = Array.from({ length: 1100 }, (_, i) => `old${i}`).join('\n');
    const bigNew = Array.from({ length: 1100 }, (_, i) => `new${i}`).join('\n');
    names.push(...heavy, small, big);
    fetchSkillSource.mockResolvedValue({
      sha: SHA,
      skills: [...heavy.map((n) => sk(n, heavyOld)), sk(small, 'one\ntwo\nthree'), sk(big, bigOld)],
    });
    const { source } = await installSkillSource(
      prisma,
      {
        createdById: userId,
        host: 'github.com',
        orgId: null,
        owner: `o-${tag}`,
        path: `p-${rnd()}`,
        ref: 'main',
        repo: 'skills',
        scope: 'GLOBAL',
        scriptMode: 'TEXT_ONLY',
        sha: SHA,
        skills: [...heavy, small, big],
        teamId: null,
      } as never,
      async () => {}
    );
    await prisma.skillSource.update({
      data: { latestSha: NEW_SHA, status: 'UPDATE_AVAILABLE' },
      where: { id: source.id },
    });
    fetchSkillSource.mockResolvedValue({
      sha: NEW_SHA,
      skills: [...heavy.map((n) => sk(n, heavyNew)), sk(small, 'one\nTWO\nthree'), sk(big, bigNew)],
    });
    // Every heavy skill is hand-edited (a conflict: diffed, never chosen unnamed).
    for (const n of heavy) {
      const row = await prisma.skill.findFirstOrThrow({ where: { name: n } });
      await updateSkill(prisma, row, { promptText: `${heavyOld}\nlocal note` }, userId);
    }

    const diff = (await call('GET', `/${source.id}/diff`)).json().data.changed as Array<{
      name: string;
      diffIncomplete: boolean;
      diffTooLarge: boolean;
    }>;
    // The small skill's diff is complete although the skills before it cost millions of steps.
    expect(diff.find((c) => c.name === small)).toMatchObject({ diffIncomplete: false });
    expect(diff.find((c) => c.name === big)).toMatchObject({
      diffIncomplete: true,
      diffTooLarge: true,
    });

    // The live text of the conflicts changes (the admin hand-applies upstream to two of them).
    for (const n of heavy.slice(0, 2)) {
      const row = await prisma.skill.findFirstOrThrow({ where: { name: n } });
      await updateSkill(prisma, row, { promptText: heavyNew }, userId);
    }
    // The oversized skill is still refused unnamed, as it was shown; the small one was shown complete.
    const refused = await call('POST', `/${source.id}/accept`, { sha: NEW_SHA });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'SKILL_UPDATE_DIFF_INCOMPLETE',
      details: [big],
    });
    const bigRow = await prisma.skill.findFirstOrThrow({ where: { name: big } });
    expect(bigRow.promptText).toBe(bigOld);
    expect((await prisma.skill.findFirstOrThrow({ where: { name: small } })).currentRevision).toBe(
      1
    );
  }, 60000);
});
