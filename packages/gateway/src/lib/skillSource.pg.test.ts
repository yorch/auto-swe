import { prisma } from '@auto-swe/shared/db';
import type { SkillSourceDeps } from '@auto-swe/shared/lib/skillSource';
import { sweepSkillSources } from '@auto-swe/shared/lib/skillSourceSync';
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
// The scan and the GitHub fetcher have their own suites; what is under test
// here is what the database does with what they return.
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({ scanSkillContent }));
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
  describe('tracked updates', () => {
    const upstream = (name: string, text: string) => ({
      description: `${name} d`,
      errors: [],
      folder: `skills/${name}`,
      name,
      promptText: text,
      referenceFiles: [{ content: 'ref2', path: 'n.md' }],
      skippedFiles: [],
    });
    const accept = (id: string, body: unknown) =>
      app.inject({
        headers: { authorization: 'Bearer t' },
        method: 'POST',
        payload: body as never,
        url: `/api/v1/platform/skill-sources/${id}/accept`,
      });

    /** A source with `names` installed at SHA (verified, so a reset is visible) and a newer commit recorded. */
    async function installed(names: string[]) {
      const prefixed = names.map((n) => `${n}-${tag}`);
      skillNames.push(...prefixed);
      fetchSkillSource.mockResolvedValue({
        sha: SHA,
        skills: prefixed.map((name) => ({
          ...upstream(name, `text of ${name}`),
          referenceFiles: [],
        })),
      });
      const { installed: rows, source: row } = await installSkillSource(
        prisma,
        {
          ...location({ path: `upd-${rnd()}` }),
          createdById: userId,
          orgId: null,
          scope: 'GLOBAL',
          scriptMode: 'TEXT_ONLY',
          sha: SHA,
          skills: prefixed,
          teamId: null,
        } as never,
        async () => {}
      );
      sourceIds.add(row.id);
      await runUnscoped('test verifies the skills it just installed', ['Skill'], () =>
        prisma.skill.updateMany({
          data: { isVerified: true },
          where: { id: { in: rows.map((r) => r.id) } },
        })
      );
      await prisma.skillSource.update({
        data: { latestSha: NEW_SHA, status: 'UPDATE_AVAILABLE' },
        where: { id: row.id },
      });
      return { names: prefixed, row, rows };
    }
    const upstreamV2 = (names: string[]) =>
      fetchSkillSource.mockResolvedValue({
        sha: NEW_SHA,
        skills: names.map((n) => upstream(n, `v2 of ${n}`)),
      });
    const revs = (skillId: string) =>
      prisma.skillRevision.findMany({ orderBy: { revision: 'asc' }, where: { skillId } });

    it('writes the new revision, resets verification, moves the pin and audits, keeping revision 1', async () => {
      const { names, row, rows } = await installed(['upda']);
      upstreamV2(names);
      const res = await accept(row.id, { sha: NEW_SHA });
      expect(res.statusCode).toBe(200);
      const skill = await prisma.skill.findUniqueOrThrow({ where: { id: rows[0]?.id } });
      expect(skill).toMatchObject({
        currentRevision: 2,
        isVerified: false,
        promptText: `v2 of ${names[0]}`,
      });
      const [r1, r2] = await revs(skill.id);
      // What a running workflow pinned is exactly what it was.
      expect(r1).toMatchObject({
        promptText: `text of ${names[0]}`,
        revision: 1,
        sourceSha: SHA,
      });
      expect(r2).toMatchObject({
        createdById: userId,
        referenceFiles: [{ content: 'ref2', path: 'n.md' }],
        revision: 2,
        sourcePath: `skills/${names[0]}`,
        sourceSha: NEW_SHA,
      });
      expect(await prisma.skillSource.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        pinnedSha: NEW_SHA,
        status: 'OK',
      });
      expect(
        await prisma.configAuditLog.count({
          where: { action: 'UPDATE', entityId: row.id, entityType: 'SkillSource' },
        })
      ).toBe(1);
    });

    it('a hand edit that lands mid-accept rolls the whole accept back (409, nothing written)', async () => {
      const { names, row, rows } = await installed(['rolla', 'rollb']);
      upstreamV2(names);
      // Between the accept reading the skills and writing them, an admin edits the
      // second skill by hand: its guarded write finds a newer revision.
      scanSkillContent.mockImplementationOnce(async () => {
        const target = await prisma.skill.findUniqueOrThrow({ where: { id: rows[1]?.id } });
        await updateSkill(prisma, target, { promptText: 'hand edit mid-accept' }, userId);
        return { incomplete: false, safe: true, warnings: [] as string[] };
      });
      const res = await accept(row.id, { sha: NEW_SHA });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SKILL_CHANGED');
      // The first skill was written in the transaction and is gone again.
      expect(await prisma.skill.findUniqueOrThrow({ where: { id: rows[0]?.id } })).toMatchObject({
        currentRevision: 1,
        promptText: `text of ${names[0]}`,
      });
      expect((await revs(rows[0]?.id as string)).map((r) => r.revision)).toEqual([1]);
      // The hand edit itself stands.
      expect(await prisma.skill.findUniqueOrThrow({ where: { id: rows[1]?.id } })).toMatchObject({
        currentRevision: 2,
        promptText: 'hand edit mid-accept',
      });
      expect(await prisma.skillSource.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        pinnedSha: SHA,
        status: 'UPDATE_AVAILABLE',
      });
      expect(
        await prisma.configAuditLog.count({ where: { entityId: row.id, action: 'UPDATE' } })
      ).toBe(0);
    });

    it('two concurrent accepts of the same commit cut one revision, not two', async () => {
      const { names, row, rows } = await installed(['race']);
      upstreamV2(names);
      // Hold both accepts after they have read the skill, so both hold revision 1.
      let reached = 0;
      let release: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      scanSkillContent.mockImplementation(async () => {
        if (++reached === 2) {
          release();
        }
        await barrier;
        return { incomplete: false, safe: true, warnings: [] as string[] };
      });
      try {
        const results = await Promise.all([
          accept(row.id, { sha: NEW_SHA }),
          accept(row.id, { sha: NEW_SHA }),
        ]);
        expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        expect(results.find((r) => r.statusCode === 409)?.json().error.code).toBe('SKILL_CHANGED');
        expect((await revs(rows[0]?.id as string)).map((r) => r.revision)).toEqual([1, 2]);
      } finally {
        scanSkillContent.mockImplementation(async () => ({
          incomplete: false,
          safe: true,
          warnings: [] as string[],
        }));
      }
    });

    it('does not overwrite a hand edit unless the skill is named, and keeps the edit in history', async () => {
      const { names, row, rows } = await installed(['edited']);
      const target = await prisma.skill.findUniqueOrThrow({ where: { id: rows[0]?.id } });
      await updateSkill(prisma, target, { promptText: 'our own text' }, userId);
      upstreamV2(names);

      const first = await accept(row.id, { sha: NEW_SHA });
      expect(first.statusCode).toBe(200);
      expect(first.json().data).toMatchObject({
        accepted: [],
        conflicts: names,
        pinAdvanced: false,
      });
      expect(await prisma.skill.findUniqueOrThrow({ where: { id: rows[0]?.id } })).toMatchObject({
        currentRevision: 2,
        promptText: 'our own text',
      });

      const second = await accept(row.id, { sha: NEW_SHA, skills: names });
      expect(second.statusCode).toBe(200);
      expect(second.json().data).toMatchObject({ pinAdvanced: true });
      const history = await revs(rows[0]?.id as string);
      expect(history.map((r) => [r.revision, r.promptText])).toEqual([
        [1, `text of ${names[0]}`],
        [2, 'our own text'],
        [3, `v2 of ${names[0]}`],
      ]);
    });
  });
  describe('the sweep', () => {
    it('records latestSha and status on enabled sources only, and never touches a skill', async () => {
      const moved = await source({ path: `sw-moved-${rnd()}` });
      const same = await source({ path: `sw-same-${rnd()}` });
      const off = await source({ path: `sw-off-${rnd()}`, status: 'DISABLED' });
      const broken = await source({ path: `sw-broken-${rnd()}` });
      const skillsBefore = await runUnscoped('test counts skills', ['Skill'], () =>
        prisma.skill.count({ where: { sourceId: { in: [moved.id, same.id, off.id, broken.id] } } })
      );
      const deps = {
        approvedHosts: async () => [],
        fetch: (async (url: string | URL | Request) => {
          const u = String(url);
          if (u.includes('sw-broken')) {
            return new Response('{}', { status: 404 });
          }
          return new Response(JSON.stringify({ sha: u.includes('sw-moved') ? NEW_SHA : SHA }), {
            status: 200,
          });
        }) as typeof fetch,
        githubConfig: (async () => ({
          apiUrl: 'https://api.github.com',
          baseUrl: 'https://github.com',
        })) as unknown as SkillSourceDeps['githubConfig'],
        githubToken: (async () => 'tok') as SkillSourceDeps['githubToken'],
        platformCredential: (async () => ({
          scope: 'mismatch',
        })) as unknown as SkillSourceDeps['platformCredential'],
        privateNetworkHosts: async () => [],
      } satisfies SkillSourceDeps;
      // Every source here shares one repo, so tell them apart by the ref instead.
      await prisma.skillSource.update({ data: { ref: 'sw-moved' }, where: { id: moved.id } });
      await prisma.skillSource.update({ data: { ref: 'sw-broken' }, where: { id: broken.id } });
      const result = await sweepSkillSources(prisma, deps);
      const rows = await runUnscoped('test reads the sources it swept', ['SkillSource'], () =>
        prisma.skillSource.findMany({
          where: { id: { in: [moved.id, same.id, off.id, broken.id] } },
        })
      );
      const by = (id: string) => rows.find((r) => r.id === id);
      expect(by(moved.id)).toMatchObject({ latestSha: NEW_SHA, status: 'UPDATE_AVAILABLE' });
      expect(by(same.id)).toMatchObject({ latestSha: SHA, status: 'OK' });
      expect(by(broken.id)).toMatchObject({ lastError: expect.any(String), status: 'ERROR' });
      expect(by(off.id)).toMatchObject({ lastCheckedAt: null, status: 'DISABLED' });
      expect(by(moved.id)?.lastCheckedAt).toBeInstanceOf(Date);
      expect(result.sources.map((x) => x.id)).not.toContain(off.id);
      expect(
        await runUnscoped('test counts skills', ['Skill'], () =>
          prisma.skill.count({
            where: { sourceId: { in: [moved.id, same.id, off.id, broken.id] } },
          })
        )
      ).toBe(skillsBefore);
    });
  });
});
