import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const SHA = 'c'.repeat(40);

const { fetchSkillSource } = vi.hoisted(() => ({ fetchSkillSource: vi.fn() }));
// The scan and the GitHub fetcher have their own suites; what is under test
// here is what the database does with what they return.
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ incomplete: false, safe: true, warnings: [] })),
}));
vi.mock('@auto-swe/shared/lib/skillSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/skillSource')>()),
  fetchSkillSource,
}));

import { skillSourceRoutes } from '../routes/skillSources.js';
import { updateSkill } from './skillLibraryService.js';
import { installSkillSource } from './skillSourceService.js';

/**
 * Skill sources against real Postgres: the per-scope partial unique indexes,
 * the scope CHECK, the one-transaction install (a failure after the skills were
 * written leaves nothing behind) and the SET NULL foreign key that detaches a
 * deleted source's skills. A mocked Prisma shows none of these.
 *
 * Opt in with `SKILL_SOURCE_PG_TEST=1` and a `DATABASE_URL` that
 * `prisma migrate deploy` has been run against (it writes and deletes rows, so
 * use a throwaway one):
 *
 *   docker run -d --rm --name src-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55507:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55507/t yarn workspace @auto-swe/shared db:deploy
 *   SKILL_SOURCE_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/gateway/src/lib/skillSource.pg.test.ts
 */
const enabled = process.env.SKILL_SOURCE_PG_TEST === '1';

const rnd = () => Math.random().toString(36).slice(2, 10);

describe.skipIf(!enabled)('skill sources against Postgres', () => {
  let userId: string;
  let orgId: string;
  const teamIds: string[] = [];
  const sourceIds = new Set<string>();
  const skillNames: string[] = [];

  const location = (over: Record<string, unknown> = {}) => ({
    host: 'github.com',
    owner: `o-${tag}`,
    path: '',
    ref: 'main',
    repo: 'skills',
    ...over,
  });
  let tag = '';

  const makeTeam = async () => {
    const team = await prisma.team.create({
      data: { name: `t-${rnd()}`, orgId, slug: `t-${rnd()}` },
    });
    teamIds.push(team.id);
    return team.id;
  };
  const source = async (data: Record<string, unknown>) => {
    const row = await prisma.skillSource.create({
      data: { pinnedSha: SHA, ...location(), ...data } as never,
    });
    sourceIds.add(row.id);
    return row;
  };

  const countSources = (where: Record<string, unknown>) =>
    runUnscoped('test counts the sources of one path', ['SkillSource'], () =>
      prisma.skillSource.count({ where })
    );

  let app: FastifyInstance;

  beforeAll(async () => {
    tag = rnd();
    const user = await prisma.user.create({ data: { email: `src-${tag}@example.test` } });
    userId = user.id;
    const org = await prisma.organization.create({
      data: { name: `org-${tag}`, slug: `org-${tag}` },
    });
    orgId = org.id;
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
    await runUnscoped('test cleanup of the skills this suite created', ['Skill'], () =>
      prisma.skill.deleteMany({ where: { name: { in: skillNames } } })
    );
    await runUnscoped('test cleanup of the sources this suite created', ['SkillSource'], () =>
      prisma.skillSource.deleteMany({ where: { owner: { endsWith: tag } } })
    );
    await prisma.configAuditLog.deleteMany({ where: { actorId: userId } });
    await runUnscoped('test cleanup of the teams this suite created', ['Team'], () =>
      prisma.team.deleteMany({ where: { id: { in: teamIds } } })
    );
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  describe('one source per location per scope', () => {
    it('refuses a second GLOBAL source for the same host/owner/repo/path', async () => {
      await source({ path: 'a' });
      await expect(source({ path: 'a', ref: 'other-branch' })).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('allows a different path, repo or host', async () => {
      await source({ path: 'b' });
      await source({ path: 'b', repo: 'other' });
      await source({ host: 'ghe.example.com', path: 'b' });
    });

    it('is per scope: the same location may be a GLOBAL and a TEAM source', async () => {
      const teamId = await makeTeam();
      await source({ path: 'c' });
      await source({ path: 'c', scope: 'TEAM', teamId });
    });

    it('is per team: one TEAM source per team, two teams may each have one', async () => {
      const [t1, t2] = [await makeTeam(), await makeTeam()];
      await source({ path: 'd', scope: 'TEAM', teamId: t1 });
      await source({ path: 'd', scope: 'TEAM', teamId: t2 });
      await expect(source({ path: 'd', scope: 'TEAM', teamId: t1 })).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('is per organization', async () => {
      await source({ orgId, path: 'e', scope: 'ORGANIZATION' });
      await expect(source({ orgId, path: 'e', scope: 'ORGANIZATION' })).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('keeps a GLOBAL row free of an owner (CHECK), and a TEAM row bound to one', async () => {
      const teamId = await makeTeam();
      await expect(source({ path: 'f', teamId })).rejects.toThrow();
      await expect(source({ path: 'g', scope: 'TEAM' })).rejects.toThrow();
      await expect(source({ orgId, path: 'h', scope: 'TEAM', teamId })).rejects.toThrow();
    });
  });

  describe('install', () => {
    const fetched = (names: string[]) => ({
      sha: SHA,
      skills: names.map((name) => ({
        description: `${name} d`,
        errors: [],
        folder: `skills/${name}`,
        name,
        promptText: `text of ${name}`,
        referenceFiles: [{ content: 'ref', path: 'n.md' }],
        skippedFiles: [],
      })),
    });
    const run = (
      names: string[],
      audit: Parameters<typeof installSkillSource>[2],
      over: Record<string, unknown> = {}
    ) => {
      const prefixed = names.map((n) => `${n}-${tag}`);
      skillNames.push(...prefixed);
      fetchSkillSource.mockResolvedValue(fetched(prefixed));
      return installSkillSource(
        prisma,
        {
          ...location({ path: `install-${rnd()}` }),
          createdById: userId,
          orgId: null,
          scope: 'GLOBAL',
          scriptMode: 'TEXT_ONLY',
          sha: SHA,
          skills: prefixed,
          teamId: null,
          ...over,
        } as never,
        audit
      );
    };
    const noAudit = async () => {};

    it('writes the source, each skill, its revision 1 and the audit entry together', async () => {
      const { source: row, installed } = await run(['one', 'two'], async (tx, created) => {
        await tx.configAuditLog.create({
          data: {
            action: 'CREATE',
            actorId: userId,
            entityId: created.id,
            entityType: 'SkillSource',
          },
        });
      });
      sourceIds.add(row.id);
      expect(installed).toHaveLength(2);
      const skills = await runUnscoped('test reads the skills of one source', ['Skill'], () =>
        prisma.skill.findMany({ include: { revisions: true }, where: { sourceId: row.id } })
      );
      expect(skills).toHaveLength(2);
      for (const s of skills) {
        expect(s).toMatchObject({ currentRevision: 1, isVerified: false, scope: 'GLOBAL' });
        expect(s.sourcePath).toMatch(/^skills\//);
        expect(s.revisions).toEqual([
          expect.objectContaining({
            createdById: userId,
            referenceFiles: [{ content: 'ref', path: 'n.md' }],
            revision: 1,
            sourcePath: s.sourcePath,
            sourceSha: SHA,
          }),
        ]);
      }
      expect(
        await prisma.configAuditLog.count({
          where: { entityId: row.id, entityType: 'SkillSource' },
        })
      ).toBe(1);
    });

    it('leaves nothing behind when the transaction fails after the skills were written', async () => {
      const path = `rollback-${rnd()}`;
      const names = ['r1', 'r2'];
      await expect(
        run(
          names,
          async () => {
            throw new Error('audit write failed');
          },
          { path }
        )
      ).rejects.toThrow('audit write failed');
      expect(await countSources({ owner: location().owner, path })).toBe(0);
      expect(
        await runUnscoped('test counts the rolled-back skills', ['Skill'], () =>
          prisma.skill.count({ where: { name: { in: names.map((n) => `${n}-${tag}`) } } })
        )
      ).toBe(0);
      expect(
        await prisma.skillRevision.count({
          where: { skill: { name: { in: names.map((n) => `${n}-${tag}`) } } },
        })
      ).toBe(0);
    });

    it('refuses a name already taken, inside the transaction, writing nothing', async () => {
      const first = await run(['dup'], noAudit);
      sourceIds.add(first.source.id);
      const path = `dup-${rnd()}`;
      await expect(run(['dup'], noAudit, { path })).rejects.toMatchObject({
        code: 'NAME_CONFLICT',
      });
      expect(await countSources({ owner: location().owner, path })).toBe(0);
    });

    it('takes a place only once: a duplicate source rolls back the skills written beside it', async () => {
      const path = `race-${rnd()}`;
      const a = await run(['race-a'], noAudit, { path });
      sourceIds.add(a.source.id);
      await expect(run(['race-b'], noAudit, { path })).rejects.toMatchObject({ code: 'P2002' });
      expect(
        await runUnscoped('test counts the rolled-back skill', ['Skill'], () =>
          prisma.skill.count({ where: { name: `race-b-${tag}` } })
        )
      ).toBe(0);
    });

    it('serialises concurrent imports of one name: exactly one wins, the rest are refused', async () => {
      const names = ['contended'];
      const prefixed = names.map((n) => `${n}-${tag}`);
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => run(names, noAudit))
      );
      const won = outcomes.filter((o) => o.status === 'fulfilled');
      for (const o of won) {
        sourceIds.add((o as PromiseFulfilledResult<{ source: { id: string } }>).value.source.id);
      }
      expect(won).toHaveLength(1);
      for (const o of outcomes.filter((x) => x.status === 'rejected')) {
        expect((o as PromiseRejectedResult).reason).toMatchObject({ code: 'NAME_CONFLICT' });
      }
      expect(
        await runUnscoped('test counts the contended name', ['Skill'], () =>
          prisma.skill.count({ where: { name: prefixed[0] } })
        )
      ).toBe(1);
    });

    it('a GLOBAL import conflicts with a same-named TEAM skill, folded for case and punctuation', async () => {
      const teamId = await makeTeam();
      const name = `teamskill-${tag}`;
      skillNames.push(name);
      await prisma.skill.create({
        data: { name: `${name.toUpperCase()}.`, promptText: 'x', scope: 'TEAM', teamId },
      });
      skillNames.push(`${name.toUpperCase()}.`);
      await expect(run(['teamskill'], noAudit)).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
    });

    it('an ORGANIZATION import conflicts with a skill of any team in the organization', async () => {
      const teamId = await makeTeam();
      const name = `orgteam-${tag}`;
      skillNames.push(name);
      await prisma.skill.create({ data: { name, promptText: 'x', scope: 'TEAM', teamId } });
      await expect(
        run(['orgteam'], noAudit, { orgId, scope: 'ORGANIZATION' })
      ).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
    });

    it('a TEAM import conflicts with its organization’s skill but not with another team’s', async () => {
      const [mine, other] = [await makeTeam(), await makeTeam()];
      const orgName = `orgskill-${tag}`;
      const otherName = `otherskill-${tag}`;
      skillNames.push(orgName, otherName);
      await prisma.skill.create({
        data: { name: orgName, orgId, promptText: 'x', scope: 'ORGANIZATION' },
      });
      await prisma.skill.create({
        data: { name: otherName, promptText: 'x', scope: 'TEAM', teamId: other },
      });
      await expect(
        run(['orgskill'], noAudit, { scope: 'TEAM', teamId: mine })
      ).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
      const ok = await run(['otherskill'], noAudit, { scope: 'TEAM', teamId: mine });
      sourceIds.add(ok.source.id);
    });

    it('a description-only edit of an imported skill keeps its source provenance', async () => {
      const { installed, source: row } = await run(['provenance'], noAudit);
      sourceIds.add(row.id);
      const id = (installed[0] as { id: string }).id;
      const existing = await prisma.skill.findUniqueOrThrow({ where: { id } });
      await updateSkill(prisma, existing, { description: 'reworded' }, userId);
      const revs = await prisma.skillRevision.findMany({
        orderBy: { revision: 'asc' },
        where: { skillId: id },
      });
      expect(revs.map((r) => [r.revision, r.sourceSha])).toEqual([
        [1, SHA],
        [2, SHA],
      ]);
      expect(revs[1]?.referenceFiles).toEqual([{ content: 'ref', path: 'n.md' }]);
      const again = await prisma.skill.findUniqueOrThrow({ where: { id } });
      await updateSkill(prisma, again, { promptText: 'our own text' }, userId);
      const last = await prisma.skillRevision.findFirstOrThrow({
        orderBy: { revision: 'desc' },
        where: { skillId: id },
      });
      expect(last).toMatchObject({ revision: 3, sourcePath: null, sourceSha: null });
    });
  });

  describe('delete', () => {
    it('detaches the skills through the SET NULL foreign key, keeping them and their provenance', async () => {
      const { source: row } = await (async () => {
        const names = [`keep-${tag}`];
        skillNames.push(...names);
        fetchSkillSource.mockResolvedValue({
          sha: SHA,
          skills: [
            {
              description: 'd',
              errors: [],
              folder: 'skills/keep',
              name: names[0],
              promptText: 'kept text',
              referenceFiles: [],
              skippedFiles: [],
            },
          ],
        });
        return installSkillSource(
          prisma,
          {
            ...location({ path: `del-${rnd()}` }),
            createdById: userId,
            orgId: null,
            scope: 'GLOBAL',
            scriptMode: 'TEXT_ONLY',
            sha: SHA,
            skills: names,
            teamId: null,
          } as never,
          async () => {}
        );
      })();

      const res = await app.inject({
        headers: { authorization: 'Bearer t' },
        method: 'DELETE',
        url: `/api/v1/platform/skill-sources/${row.id}`,
      });
      expect(res.statusCode).toBe(204);

      expect(await prisma.skillSource.findUnique({ where: { id: row.id } })).toBeNull();
      const skill = await prisma.skill.findFirstOrThrow({
        include: { revisions: true },
        where: { name: `keep-${tag}` },
      });
      expect(skill.sourceId).toBeNull();
      expect(skill.promptText).toBe('kept text');
      expect(skill.revisions[0]).toMatchObject({ sourcePath: 'skills/keep', sourceSha: SHA });
      expect(
        await prisma.configAuditLog.count({
          where: { action: 'DELETE', entityId: row.id, entityType: 'SkillSource' },
        })
      ).toBe(1);
    });
  });
});
