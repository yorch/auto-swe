import crypto from 'node:crypto';
import { invalidateSettingsCache, resolveSetting } from '@auto-swe/shared/config';
import { PrismaClient, prisma } from '@auto-swe/shared/db';
import { runUnscoped, tenantGuardExtension } from '@auto-swe/shared/lib/tenantGuard';
import { PrismaPg } from '@prisma/adapter-pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamJoinRequestRoutes } from '../routes/teamJoinRequests.js';
import { teamRoutes } from '../routes/teams.js';
import { loadDirectory, loadDirectoryOrganizations } from './teamJoinRequests.js';

/**
 * The directory's organization search against real Postgres: the same visibility rule as the
 * directory under both platform values and per-organization overrides, the name-keyset paging, and
 * a time bound on tens of thousands of organizations whose planner statistics are stale (no ANALYZE
 * after the load). The route, the service and the real tenant guard all run.
 *
 * Opt in with `DIRECTORY_ORGANIZATIONS_PG_TEST=1` and a throwaway `DATABASE_URL` that
 * `prisma migrate deploy` has been run against. It sets and clears the platform-wide
 * `teams.directoryScope` row, so do not run it beside another suite that does.
 */
const enabled = process.env.DIRECTORY_ORGANIZATIONS_PG_TEST === '1';

type Scope = 'platform' | 'organization';

describe.skipIf(!enabled)('directory organization search against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const name = (label: string) => `do-${suffix}-${label}`;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  let app: FastifyInstance;
  /** The GLOBAL `teams.directoryScope` rows this database held before the suite, put back at the end. */
  let originalPlatformRows: Array<{ value: unknown }> = [];

  const setPlatformValue = (value: Scope | null) =>
    runUnscoped('test: the platform-wide directory scope', ['ConfigSetting'], async () => {
      await prisma.configSetting.deleteMany({
        where: { key: 'teams.directoryScope', scope: 'GLOBAL' },
      });
      if (value) {
        await prisma.configSetting.create({
          data: { key: 'teams.directoryScope', scope: 'GLOBAL', value },
        });
      }
      invalidateSettingsCache();
    });

  async function makeUser(label: string) {
    const user = await prisma.user.create({ data: { email: `${name(label)}@example.test` } });
    userIds.push(user.id);
    return user.id;
  }
  async function makeOrg(label: string, isActive = true) {
    const org = await prisma.organization.create({
      data: { isActive, name: name(`org-${label}`), slug: name(`org-${label}`) },
    });
    orgIds.push(org.id);
    return org.id;
  }
  async function makeTeam(label: string, orgId: string, isActive = true) {
    const team = await prisma.team.create({
      data: { isActive, name: name(`team-${label}`), orgId, slug: name(`team-${label}`) },
    });
    return team.id;
  }
  const override = (orgId: string, value: unknown) =>
    prisma.configSetting.create({
      data: { key: 'teams.directoryScope', orgId, scope: 'ORGANIZATION', value: value as never },
    });

  const call = async (viewer: string, url: string) => {
    const res = await app.inject({
      headers: { authorization: `Bearer ${viewer}` },
      method: 'GET',
      url,
    });
    return { body: res.json(), status: res.statusCode };
  };

  /** Every page of the search, following `nextCursor`. */
  async function allPages(viewer: string, query: string, limit: number) {
    const names: string[] = [];
    const pages: number[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/api/v1/teams/directory/organizations?limit=${limit}&${query}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      const { body, status } = await call(viewer, url);
      expect(status, url).toBe(200);
      pages.push(body.organizations.length);
      names.push(...body.organizations.map((o: { name: string }) => o.name));
      cursor = body.nextCursor;
    } while (cursor);
    return { names, pages };
  }

  beforeAll(async () => {
    originalPlatformRows = await runUnscoped(
      'test: remember the platform-wide directory scope',
      ['ConfigSetting'],
      () =>
        prisma.configSetting.findMany({
          select: { value: true },
          where: { key: 'teams.directoryScope', scope: 'GLOBAL' },
        })
    );
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: (token: string) => ({
        exp: 9_999_999_999,
        iat: 0,
        role: 'USER',
        sub: token,
      }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    // The directory registers before `teamRoutes`, whose `/:id` must not be the one to answer it.
    await app.register(teamJoinRequestRoutes, { prefix: '/api/v1/teams' });
    await app.register(teamRoutes, { prefix: '/api/v1/teams' });
    await app.ready();
  });

  afterAll(async () => {
    await setPlatformValue(null);
    await runUnscoped('test: restore the platform-wide directory scope', ['ConfigSetting'], () =>
      prisma.configSetting.createMany({
        data: originalPlatformRows.map((r) => ({
          key: 'teams.directoryScope',
          scope: 'GLOBAL' as const,
          value: r.value as never,
        })),
      })
    );
    invalidateSettingsCache();
    await runUnscoped(
      'test fixture: throwaway database',
      ['Team', 'OrganizationMembership'],
      async () => {
        await prisma.team.deleteMany({ where: { orgId: { in: orgIds } } });
        await prisma.organizationMembership.deleteMany({ where: { orgId: { in: orgIds } } });
      }
    );
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  it('answers by the directory rule, per organization, under both platform values', async () => {
    const viewer = await makeUser('viewer');
    const sample = {
      dead: await makeOrg('sr-dead', false), // inactive, an active team inside it
      hidden: await makeOrg('sr-hidden'), // chose `organization`; the viewer is outside
      inactiveTeam: await makeOrg('sr-inactive-team'), // its only team is deactivated
      invalid: await makeOrg('sr-invalid'), // a stored value the schema rejects
      member: await makeOrg('sr-member'), // chose `organization`; the viewer is inside
      noTeam: await makeOrg('sr-no-team'), // no team at all
      open: await makeOrg('sr-open'), // chose `platform`
      plain: await makeOrg('sr-plain'), // no override
      wrongCase: await makeOrg('sr-wrong-case'), // `Platform`, not a valid value
    };
    await prisma.organizationMembership.create({
      data: { orgId: sample.member, role: 'MEMBER', userId: viewer },
    });
    await override(sample.hidden, 'organization');
    await override(sample.invalid, 'nonsense');
    await override(sample.member, 'organization');
    await override(sample.open, 'platform');
    await override(sample.wrongCase, 'Platform');
    for (const [label, orgId] of Object.entries(sample)) {
      if (label !== 'noTeam') {
        await makeTeam(`sr-${label}`, orgId, label !== 'inactiveTeam');
      }
    }
    // The oracle needs the names back.
    const nameOf = new Map(
      (
        await prisma.organization.findMany({
          select: { id: true, name: true },
          where: { id: { in: orgIds } },
        })
      ).map((o) => [o.id, o.name])
    );
    const hasActiveTeam = (label: string) => label !== 'noTeam' && label !== 'inactiveTeam';

    try {
      for (const platformValue of ['platform', 'organization'] as const) {
        await setPlatformValue(platformValue === 'platform' ? null : 'organization');

        // The oracle: the rule written out per organization with the per-organization resolver.
        const expected: string[] = [];
        for (const [label, orgId] of Object.entries(sample)) {
          const scope = await resolveSetting('teams.directoryScope', { orgId });
          const visible = label !== 'dead' && (orgId === sample.member || scope === 'platform');
          if (visible && hasActiveTeam(label)) {
            expected.push(nameOf.get(orgId) as string);
          }
        }
        expected.sort();
        invalidateSettingsCache();

        const found = await allPages(viewer, `q=${encodeURIComponent(name('org-sr-'))}`, 100);
        expect([...found.names].sort(), platformValue).toEqual(expected);
        // Hidden, inactive and team-less organizations never appear, under either value.
        for (const label of ['dead', 'noTeam', 'inactiveTeam', 'invalid', 'wrongCase'] as const) {
          const listed = found.names.includes(nameOf.get(sample[label]) as string);
          const byRule =
            (label === 'invalid' || label === 'wrongCase') && platformValue === 'platform';
          expect(listed, `${platformValue}/${label}`).toBe(byRule);
        }

        // The directory's own filter and its teams say the same thing.
        const dir = await loadDirectory(
          prisma,
          { role: 'USER', sub: viewer },
          {
            limit: 100,
            q: name('team-sr-'),
          }
        );
        expect(dir.ok).toBe(true);
        if (!dir.ok) {
          return;
        }
        expect(dir.scope).toBe(platformValue);
        const prefix = name('org-sr-');
        expect(
          dir.organizations
            .map((o) => o.name)
            .filter((n) => n.startsWith(prefix))
            .sort(),
          platformValue
        ).toEqual(expected);
        expect(dir.teams.map((t) => t.orgName).sort(), platformValue).toEqual(expected);

        // Someone outside every organization sees the platform-wide answer only.
        const outsider = await makeUser(`outsider-${platformValue}`);
        const outside = await allPages(outsider, `q=${encodeURIComponent(prefix)}`, 100);
        const expectedOutside = expected.filter((n) => n !== nameOf.get(sample.member));
        expect([...outside.names].sort(), platformValue).toEqual(expectedOutside);
      }
    } finally {
      await setPlatformValue(null);
    }
  }, 60_000);

  it('searches case-insensitively by name and pages by name across more than 100 organizations', async () => {
    const viewer = await makeUser('pager');
    const prefix = name('pg-');
    const COUNT = 230;
    await prisma.organization.createMany({
      data: Array.from({ length: COUNT }, (_, i) => ({
        name: `${prefix}${String(i).padStart(4, '0')}${i % 2 === 0 ? 'Even' : 'odd'}`,
        slug: `${prefix}${i}`,
      })),
    });
    const created = await prisma.organization.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
      where: { name: { startsWith: prefix } },
    });
    orgIds.push(...created.map((o) => o.id));
    await prisma.team.createMany({
      data: created.map((o, i) => ({
        name: `${prefix}t${i}`,
        orgId: o.id,
        slug: `${prefix}t${i}`,
      })),
    });

    // The default page size is 50.
    const first = await call(viewer, `/api/v1/teams/directory/organizations?q=${prefix}`);
    expect(first.status).toBe(200);
    expect(first.body.organizations).toHaveLength(50);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(Object.keys(first.body.organizations[0]).sort()).toEqual(['id', 'name']);

    // 230 organizations at limit 100: 100, 100, 30, each exactly once and in name order.
    const all = await allPages(viewer, `q=${encodeURIComponent(prefix)}`, 100);
    expect(all.pages).toEqual([100, 100, 30]);
    expect(all.names).toEqual(created.map((o) => o.name));
    expect(new Set(all.names).size).toBe(COUNT);
    // A page size that does not divide the total, and the smallest page.
    expect((await allPages(viewer, `q=${encodeURIComponent(prefix)}`, 7)).names).toEqual(all.names);
    const tiny = await allPages(viewer, `q=${encodeURIComponent(`${prefix}0001`)}`, 1);
    expect(tiny.names).toEqual([`${prefix}0001odd`]);

    // `q` is a case-insensitive substring of the name; the last page has no cursor.
    const upper = await allPages(viewer, `q=${encodeURIComponent(prefix.toUpperCase())}`, 100);
    expect(upper.names).toEqual(all.names);
    const even = await allPages(viewer, `q=${encodeURIComponent('0004EVEN')}`, 100);
    expect(even.names).toEqual([`${prefix}0004Even`]);
    const last = await call(
      viewer,
      `/api/v1/teams/directory/organizations?limit=100&q=${encodeURIComponent(prefix)}&cursor=${encodeURIComponent(
        Buffer.from(JSON.stringify({ n: created[199]?.name }), 'utf8').toString('base64url')
      )}`
    );
    expect(last.body.organizations).toHaveLength(30);
    expect(last.body.nextCursor).toBeNull();
    const none = await call(
      viewer,
      '/api/v1/teams/directory/organizations?q=no-such-organization-name'
    );
    expect(none.body).toEqual({ nextCursor: null, organizations: [] });
  }, 60_000);

  it('orders and pages correctly when the organizations with a team span several chunks', async () => {
    const viewer = await makeUser('chunks');
    const prefix = name('ch-');
    const COUNT = 2600; // more than two chunks of 1,000, so the winners are re-chunked
    const rows = Array.from({ length: COUNT }, (_, i) => ({
      id: crypto.randomUUID(),
      name: `${prefix}${String((i * 7919) % COUNT).padStart(5, '0')}`,
    }));
    await prisma.organization.createMany({
      data: rows.map((r) => ({ id: r.id, name: r.name, slug: r.name })),
    });
    orgIds.push(...rows.map((r) => r.id));
    await prisma.team.createMany({
      data: rows.map((r, i) => ({ name: `${prefix}t${i}`, orgId: r.id, slug: `${prefix}t${i}` })),
    });
    // Every 13th organization chose `organization`: hidden from this viewer, scattered over the chunks.
    const hidden = rows.filter((_, i) => i % 13 === 0);
    await prisma.configSetting.createMany({
      data: hidden.map((r) => ({
        key: 'teams.directoryScope',
        orgId: r.id,
        scope: 'ORGANIZATION' as const,
        value: 'organization',
      })),
    });
    const hiddenIds = new Set<string>(hidden.map((r) => r.id));
    // The database's own order, which the cursor is in.
    const inOrder = await prisma.organization.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
      where: { name: { startsWith: prefix } },
    });
    const expected = inOrder.filter((o) => !hiddenIds.has(o.id)).map((o) => o.name);
    expect(expected.length).toBe(COUNT - hidden.length);

    const all = await allPages(viewer, `q=${encodeURIComponent(prefix)}`, 100);
    expect(all.names).toEqual(expected);
    expect(all.pages.slice(0, -1).every((n) => n === 100)).toBe(true);
    // A search that only some chunks hold, and the unscoped directory filter's first 500.
    const some = await allPages(viewer, `q=${encodeURIComponent(`${prefix}012`)}`, 30);
    expect(some.names).toEqual(expected.filter((n) => n.includes(`${prefix}012`)));
    // The unscoped directory filter lists the first 500 organizations of the whole table, and a
    // seeded database holds others ('Default Organization', rows other suites leave) that sort
    // among or before this prefix. So the assertion is about this run's rows only: they appear in
    // order, as one unbroken run, and are the first of `expected` that the 500 reach.
    const dir = await loadDirectory(prisma, { role: 'USER', sub: viewer }, { limit: 1 });
    expect(dir.ok).toBe(true);
    if (dir.ok) {
      const listed = dir.organizations.map((o) => o.name);
      const ours = listed.filter((n) => n.startsWith(prefix));
      expect(ours).toEqual(expected.slice(0, ours.length));
      const firstAt = listed.findIndex((n) => n.startsWith(prefix));
      if (ours.length > 0) {
        expect(listed.slice(firstAt, firstAt + ours.length)).toEqual(ours);
      }
      // Whatever sorts before the prefix is foreign; if fewer than 500 of those exist the filter
      // must have reached this run's organizations, and it was truncated either way.
      const foreignBefore = await prisma.organization.count({
        where: {
          isActive: true,
          name: { lt: prefix },
          teams: { some: { isActive: true } },
        },
      });
      // The page holds 500 organizations in name order: the foreign ones that sort before the
      // prefix come first and this run's follow, so exactly the first `500 - foreignBefore` of the
      // expected names appear, in order. A weaker bound passes a page that lost some of them.
      const room = Math.max(0, 500 - foreignBefore);
      expect(ours).toEqual(expected.slice(0, Math.min(room, expected.length)));
      expect(listed).toHaveLength(500);
      expect(dir.organizationsTruncated).toBe(true);
    }
  }, 120_000);

  it('refuses a cursor it did not issue and an out-of-range limit', async () => {
    const viewer = await makeUser('refused');
    const bad = await call(viewer, '/api/v1/teams/directory/organizations?cursor=not-a-cursor');
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code ?? bad.body.code).toBe('INVALID_CURSOR');
    for (const limit of ['0', '101', 'abc']) {
      const res = await call(viewer, `/api/v1/teams/directory/organizations?limit=${limit}`);
      expect(res.status, limit).toBe(400);
    }
    // Unauthenticated callers are not served.
    const anon = await app.inject({ method: 'GET', url: '/api/v1/teams/directory/organizations' });
    expect(anon.statusCode).toBe(401);
  });

  /* ── The plan bound ──────────────────────────────────────────────────────── */

  it('lists tens of thousands of organizations quickly with planner statistics that no longer describe the tables', async () => {
    const BULK = 40_000;
    const bulkPrefix = name('big-');
    const TEAMS = 520;
    const BOUND_MS = 2000;
    const tables = ['organizations', 'teams', 'config_settings'] as const;
    const touched: string[] = [];
    // CLAUDE.md §7 exception: planner and autovacuum settings of the fixture's tables, not data.
    const setAutovacuum = async (on: boolean) => {
      for (const table of tables) {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE ${table} SET (autovacuum_enabled = ${on ? 'true' : 'false'})`
        );
      }
    };
    await setAutovacuum(false);
    try {
      for (let from = 0; from < BULK; from += 5000) {
        const ids = Array.from({ length: 5000 }, () => crypto.randomUUID());
        touched.push(...ids);
        await prisma.organization.createMany({
          data: ids.map((id, i) => ({
            id,
            name: `${bulkPrefix}${String(from + i).padStart(6, '0')}`,
            slug: `${bulkPrefix}${from + i}`,
          })),
        });
      }
      // Statistics taken while every organization owned a team, and a bloated `teams` table...
      for (let from = 0; from < BULK; from += 5000) {
        await prisma.team.createMany({
          data: touched.slice(from, from + 5000).map((orgId, i) => ({
            name: `${bulkPrefix}t${from + i}`,
            orgId,
            slug: `${bulkPrefix}t${from + i}`,
          })),
        });
      }
      // CLAUDE.md §7 exception: refreshes the server's planner statistics, not application data.
      await prisma.$executeRawUnsafe('ANALYZE organizations, teams, config_settings');
      // ...then almost all of those teams go, and nothing analyzes again.
      const keep = touched.slice(-TEAMS);
      await runUnscoped('test fixture: bulk teams', ['Team'], () =>
        prisma.team.deleteMany({
          where: { name: { startsWith: `${bulkPrefix}t` }, orgId: { notIn: keep } },
        })
      );
      const bulkTeams = await prisma.team.findMany({
        select: { id: true },
        where: { orgId: { in: keep } },
      });
      expect(bulkTeams).toHaveLength(TEAMS);

      // A few hundred overrides, on organizations with and without a team.
      const overridden = [...keep.filter((_, i) => i % 3 === 0), ...touched.slice(0, 150)];
      await prisma.configSetting.createMany({
        data: overridden.map((orgId, i) => ({
          key: 'teams.directoryScope',
          orgId,
          scope: 'ORGANIZATION' as const,
          value: i % 2 === 0 ? 'organization' : 'platform',
        })),
      });
      const viewer = await makeUser('big-viewer');
      await prisma.organizationMembership.create({
        data: { orgId: touched[BULK - 1] as string, role: 'MEMBER', userId: viewer },
      });
      const stranger = await makeUser('big-stranger');

      // The statements the service really sends, with their parameters, to read the plans from.
      const statements: Array<{ params: string; query: string }> = [];
      const base = new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
        log: [{ emit: 'event', level: 'query' }],
      });
      (
        base as unknown as {
          $on: (e: 'query', cb: (q: { params: string; query: string }) => void) => void;
        }
      ).$on('query', (q) => statements.push({ params: q.params, query: q.query }));
      const logged = base.$extends(tenantGuardExtension()) as unknown as typeof prisma;

      const report: string[] = [];
      try {
        for (const platformValue of ['platform', 'organization'] as const) {
          await setPlatformValue(platformValue === 'platform' ? null : 'organization');
          for (const [who, sub] of [
            ['member', viewer],
            ['stranger', stranger],
          ] as const) {
            statements.length = 0;
            const t0 = performance.now();
            const page = await loadDirectoryOrganizations(
              logged,
              { role: 'USER', sub },
              { limit: 100 }
            );
            const searchMs = performance.now() - t0;
            const sent = [...statements];
            const t1 = performance.now();
            const dir = await loadDirectory(logged, { role: 'USER', sub }, { limit: 50 });
            const directoryMs = performance.now() - t1;
            expect(page.ok && dir.ok).toBe(true);
            if (!(page.ok && dir.ok)) {
              return;
            }
            // The directory's filter is the first 500 names of the search, whatever the size.
            const everything = await allPages(sub, '', 100);
            expect(everything.names.length, `${platformValue}/${who}`).toBeGreaterThan(0);
            expect(dir.organizations.map((o) => o.name)).toEqual(everything.names.slice(0, 500));
            expect(dir.organizationsTruncated).toBe(everything.names.length > 500);
            expect(page.organizations.map((o) => o.name)).toEqual(everything.names.slice(0, 100));
            report.push(
              `${platformValue}/${who}: search ${searchMs.toFixed(0)} ms (${sent.length} statements), directory ${directoryMs.toFixed(0)} ms`
            );
            expect(searchMs, `search ${platformValue}/${who}`).toBeLessThan(BOUND_MS);
            expect(directoryMs, `directory ${platformValue}/${who}`).toBeLessThan(BOUND_MS);

            // No parameter list grows with the organizations or the overrides.
            for (const s of sent) {
              expect(JSON.parse(s.params).length).toBeLessThanOrEqual(1100);
            }
            // The plan of the organization statement starts from the primary keys it was handed,
            // never from a scan of `organizations`.
            const chunk = sent.find(
              (s) => s.query.includes('FROM "public"."organizations"') && s.query.includes('IN ($')
            );
            expect(chunk, 'the organization statement').toBeDefined();
            if (chunk && platformValue === 'platform' && who === 'member') {
              const plan = (await prisma.$queryRawUnsafe(
                `EXPLAIN ${chunk.query}`,
                ...(JSON.parse(chunk.params) as unknown[])
              )) as Array<Record<string, string>>;
              const text = plan.map((r) => r['QUERY PLAN']).join('\n');
              report.push(`organization statement plan:\n${text}`);
              expect(text).toContain('organizations_pkey');
              expect(text).not.toMatch(/Seq Scan on organizations/);
            }
          }
        }
      } finally {
        await base.$disconnect();
        // The recorded plan and times, for a person reading the test log.
        console.info(`directory organizations at ${BULK} organizations\n${report.join('\n')}`);
      }
    } finally {
      await setPlatformValue(null);
      await setAutovacuum(true);
      await runUnscoped('test fixture: bulk teams', ['Team'], () =>
        prisma.team.deleteMany({ where: { name: { startsWith: `${bulkPrefix}t` } } })
      );
      await prisma.organization.deleteMany({ where: { name: { startsWith: bulkPrefix } } });
    }
  }, 300_000);
});
