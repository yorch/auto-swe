import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { JwtPayload } from '../plugins/auth.js';
import { organizationRoutes } from '../routes/organizations.js';
import {
  approveAtOrgStep,
  approveAtTeamStep,
  createJoinRequest,
  loadDirectory,
  rejectAtOrgStep,
  rejectAtTeamStep,
  withdrawRequest,
} from './teamJoinRequests.js';

/**
 * Organization deactivation against real Postgres: the transaction that locks the organization row,
 * flips the flag and closes the open requests of its teams, the refusal of the organization that
 * owns the default team, and the approval, rejection and creation paths that must see an inactive
 * organization under the locks they take. A deactivation racing a decision is the property a mocked
 * Prisma cannot show: one of the two wins, and no request is left open for an inactive organization.
 *
 * Opt in with `ORGANIZATION_DEACTIVATION_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate
 * deploy` has been run against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.ORGANIZATION_DEACTIVATION_PG_TEST === '1';

describe.skipIf(!enabled)('organization deactivation against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const name = (label: string) => `od-${suffix}-${label}`;
  const fastify = { prisma } as unknown as FastifyInstance;
  const orgIds: string[] = [];
  const teamIds: string[] = [];
  const userIds: string[] = [];
  const savedDefaultSlug = process.env.DEFAULT_TEAM_SLUG;

  const actorOf = (id: string): JwtPayload => ({ exp: 0, iat: 0, role: 'USER', sub: id });
  const actAs = (id: string) => ({ authorization: `Bearer ${id}` });

  async function makeUser(label: string) {
    const user = await prisma.user.create({ data: { email: `${name(label)}@example.test` } });
    userIds.push(user.id);
    return user.id;
  }
  async function makeOrg(label: string) {
    const org = await prisma.organization.create({
      data: { name: name(`org-${label}`), slug: name(`org-${label}`) },
    });
    orgIds.push(org.id);
    return org.id;
  }
  async function makeTeam(label: string, orgId: string, slug = name(`team-${label}`)) {
    const team = await prisma.team.create({ data: { name: slug, orgId, slug } });
    teamIds.push(team.id);
    return team.id;
  }
  const inOrg = (userId: string, orgId: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') =>
    prisma.organizationMembership.create({ data: { orgId, role, userId } });
  const onTeam = (userId: string, teamId: string, role: 'ADMIN' | 'LEAD' | 'MEMBER') =>
    prisma.teamMembership.create({ data: { role, teamId, userId } });

  let platformAdmin: string;
  let outsideOrg: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    platformAdmin = await makeUser('platform-admin');
    outsideOrg = await makeOrg('outside');

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: (token: string) => ({
        exp: 9_999_999_999,
        iat: 0,
        role: token === platformAdmin ? 'ADMIN' : 'USER',
        sub: token,
      }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    // Both registrations of the real plugin, as `routes/register.ts` mounts it.
    await app.register(organizationRoutes, { prefix: '/api/v1/platform/organizations' });
    await app.register(organizationRoutes, { prefix: '/api/v1/admin/organizations' });
    await app.ready();
  });

  afterEach(() => {
    if (savedDefaultSlug === undefined) {
      delete process.env.DEFAULT_TEAM_SLUG;
    } else {
      process.env.DEFAULT_TEAM_SLUG = savedDefaultSlug;
    }
  });

  afterAll(async () => {
    await runUnscoped(
      'test fixture: throwaway database',
      ['OrganizationMembership', 'Team', 'TeamJoinRequest', 'TeamMembership'],
      async () => {
        await prisma.teamJoinRequest.deleteMany({ where: { team: { orgId: { in: orgIds } } } });
        await prisma.teamMembership.deleteMany({ where: { team: { orgId: { in: orgIds } } } });
        await prisma.team.deleteMany({ where: { orgId: { in: orgIds } } });
        await prisma.organizationMembership.deleteMany({ where: { orgId: { in: orgIds } } });
      }
    );
    await prisma.configAuditLog.deleteMany({
      where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: [...orgIds, ...teamIds] } }] },
    });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  /** An organization with two teams, each led by a lead, and an organization admin. */
  async function scenario(label: string) {
    const orgId = await makeOrg(label);
    const orgAdmin = await makeUser(`org-admin-${label}`);
    await inOrg(orgAdmin, orgId, 'ADMIN');
    const teams = [];
    for (const letter of ['a', 'b']) {
      const teamId = await makeTeam(`${label}-${letter}`, orgId);
      const lead = await makeUser(`lead-${label}-${letter}`);
      await inOrg(lead, orgId);
      await onTeam(lead, teamId, 'LEAD');
      teams.push({ lead, teamId });
    }
    return { orgAdmin, orgId, teams };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  /** A person who is a member of the scenario's organization, or of another one. */
  async function requesterOf(label: string, orgId: string | null) {
    const id = await makeUser(`req-${label}`);
    if (orgId) {
      await inOrg(id, orgId);
    }
    return id;
  }

  const create = async (userId: string, teamId: string) => {
    const made = await createJoinRequest(fastify, {
      actor: actorOf(userId),
      context: {},
      message: 'hi',
      teamId,
    });
    if (!made.ok) {
      throw new Error(`setup failed: ${made.code}`);
    }
    return made.request.id;
  };
  const teamApprove = (reviewer: string, teamId: string, requestId: string) =>
    approveAtTeamStep(fastify, { actor: actorOf(reviewer), context: {}, requestId, teamId });
  const teamReject = (reviewer: string, teamId: string, requestId: string) =>
    rejectAtTeamStep(fastify, { actor: actorOf(reviewer), context: {}, requestId, teamId });
  const orgApprove = (reviewer: string, orgId: string, requestId: string) =>
    approveAtOrgStep(fastify, { actor: actorOf(reviewer), context: {}, orgId, requestId });
  const orgReject = (reviewer: string, orgId: string, requestId: string) =>
    rejectAtOrgStep(fastify, { actor: actorOf(reviewer), context: {}, orgId, requestId });

  /** A request from outside the organization, approved at the team step: waiting for the organization. */
  async function waitingForOrg(s: Scenario, label: string, teamIndex = 0) {
    const requester = await requesterOf(label, outsideOrg);
    const team = s.teams[teamIndex] as Scenario['teams'][number];
    const requestId = await create(requester, team.teamId);
    const decided = await teamApprove(team.lead, team.teamId, requestId);
    expect(decided.ok && decided.request.status).toBe('PENDING_ORG');
    return { requester, requestId, ...team };
  }

  const requestRow = (id: string) =>
    runUnscoped('test: read one request', ['TeamJoinRequest'], () =>
      prisma.teamJoinRequest.findUniqueOrThrow({ where: { id } })
    );
  const openIn = (orgId: string) =>
    runUnscoped('test: count open requests of an organization', ['TeamJoinRequest'], () =>
      prisma.teamJoinRequest.count({
        where: { status: { in: ['PENDING_ORG', 'PENDING_TEAM'] }, team: { orgId } },
      })
    );
  const membershipCount = (userId: string, teamId: string) =>
    prisma.teamMembership.count({ where: { teamId, userId } });
  const isActive = async (orgId: string) =>
    (await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).isActive;
  const orgAudits = (orgId: string) =>
    prisma.configAuditLog.findMany({
      orderBy: { createdAt: 'asc' },
      where: { entityId: orgId, entityType: 'Organization' },
    });
  /** Deactivation as the platform does it, bypassing the close: the state a decision may still meet. */
  const markInactive = (orgId: string) =>
    prisma.organization.update({ data: { isActive: false }, where: { id: orgId } });

  const patch = (
    caller: string,
    orgId: string,
    payload: Record<string, unknown>,
    prefix = 'platform'
  ) =>
    app.inject({
      headers: actAs(caller),
      method: 'PATCH',
      payload,
      url: `/api/v1/${prefix}/organizations/${orgId}`,
    });
  const setActive = (orgId: string, value: boolean, caller = platformAdmin, prefix = 'platform') =>
    patch(caller, orgId, { isActive: value }, prefix);

  it('closes the open requests of every team of the organization, and nothing in another one', async () => {
    const s = await scenario('close');
    const other = await scenario('close-other');
    const memberReq = await requesterOf('close-member', s.orgId);
    const teamStepA = await create(memberReq, s.teams[0]?.teamId as string);
    const teamStepB = await create(
      await requesterOf('close-b', outsideOrg),
      s.teams[1]?.teamId as string
    );
    const orgStep = await waitingForOrg(s, 'close-org-step');
    const elsewhere = await create(
      await requesterOf('close-else', outsideOrg),
      other.teams[0]?.teamId as string
    );
    const decided = await create(
      await requesterOf('close-done', s.orgId),
      s.teams[1]?.teamId as string
    );
    const finished = await teamApprove(
      (s.teams[1] as Scenario['teams'][number]).lead,
      (s.teams[1] as Scenario['teams'][number]).teamId,
      decided
    );
    expect(finished.ok && finished.request.status).toBe('APPROVED');

    const res = await setActive(s.orgId, false);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ id: s.orgId, isActive: false });
    expect(await isActive(s.orgId)).toBe(false);
    for (const id of [teamStepA, teamStepB, orgStep.requestId]) {
      expect(await requestRow(id)).toMatchObject({
        closeReason: 'ORGANIZATION_DEACTIVATED',
        orgDecidedById: null,
        status: 'REJECTED',
        teamDecidedById: id === orgStep.requestId ? orgStep.lead : null,
      });
    }
    // A request already decided and a request of another organization are not touched.
    expect(await requestRow(decided)).toMatchObject({ closeReason: null, status: 'APPROVED' });
    expect(await requestRow(elsewhere)).toMatchObject({
      closeReason: null,
      status: 'PENDING_TEAM',
    });
    expect(await openIn(other.orgId)).toBe(1);
    expect(await openIn(s.orgId)).toBe(0);

    // One audit row per request closed, by the acting platform admin, and one for the organization.
    const closedAudits = await prisma.configAuditLog.findMany({
      where: {
        actorId: platformAdmin,
        entityId: { in: [teamStepA, teamStepB, orgStep.requestId] },
        entityType: 'TeamJoinRequest',
      },
    });
    expect(
      closedAudits.filter((a) => (a.afterJson as { systemClose?: boolean }).systemClose)
    ).toHaveLength(3);
    const [audit, ...rest] = await orgAudits(s.orgId);
    expect(rest).toHaveLength(0);
    expect(audit).toMatchObject({ action: 'UPDATE', actorId: platformAdmin });
    expect(audit?.beforeJson).toMatchObject({ isActive: true });
    expect(audit?.afterJson).toMatchObject({ closedJoinRequests: 3, isActive: false });
    expect(audit?.context).toMatchObject({ authority: 'platform-admin' });
  });

  it('starts no cooldown: after reactivation the same person asks the same team at once', async () => {
    const s = await scenario('cooldown');
    const team = s.teams[0] as Scenario['teams'][number];
    const requester = await requesterOf('cooldown', outsideOrg);
    const first = await create(requester, team.teamId);

    expect((await setActive(s.orgId, false)).statusCode).toBe(200);
    expect(await requestRow(first)).toMatchObject({ status: 'REJECTED' });
    expect((await setActive(s.orgId, true)).statusCode).toBe(200);

    const again = await createJoinRequest(fastify, {
      actor: actorOf(requester),
      context: {},
      message: 'again',
      teamId: team.teamId,
    });
    expect(again).toMatchObject({ ok: true });
  });

  it('reactivates without reopening anything, and audits it', async () => {
    const s = await scenario('reactivate');
    const requester = await requesterOf('reactivate', outsideOrg);
    const closed = await create(requester, (s.teams[0] as Scenario['teams'][number]).teamId);
    await setActive(s.orgId, false);
    const before = await requestRow(closed);

    const res = await setActive(s.orgId, true);

    expect(res.statusCode, res.body).toBe(200);
    expect(await isActive(s.orgId)).toBe(true);
    expect(await requestRow(closed)).toMatchObject({
      closeReason: 'ORGANIZATION_DEACTIVATED',
      status: 'REJECTED',
      updatedAt: before.updatedAt,
    });
    expect(await openIn(s.orgId)).toBe(0);
    const audits = await orgAudits(s.orgId);
    expect(audits).toHaveLength(2);
    expect(audits[1]?.beforeJson).toMatchObject({ isActive: false });
    expect(audits[1]?.afterJson).toMatchObject({ isActive: true });
  });

  it('is idempotent: a value that does not change writes no audit row and closes nothing', async () => {
    const s = await scenario('idempotent');
    expect((await setActive(s.orgId, true)).statusCode).toBe(200);
    expect(await orgAudits(s.orgId)).toHaveLength(0);

    expect((await setActive(s.orgId, false)).statusCode).toBe(200);
    expect(await orgAudits(s.orgId)).toHaveLength(1);
    // A request that appears while the organization is inactive (an old row, written around the
    // service) is not swept by a second, unchanged deactivation.
    const requester = await requesterOf('idempotent', outsideOrg);
    const stray = await prisma.teamJoinRequest.create({
      data: { teamId: (s.teams[0] as Scenario['teams'][number]).teamId, userId: requester },
    });
    const again = await setActive(s.orgId, false);

    expect(again.statusCode, again.body).toBe(200);
    expect(await orgAudits(s.orgId)).toHaveLength(1);
    expect((await requestRow(stray.id)).status).toBe('PENDING_TEAM');
  });

  it('works through the admin alias too', async () => {
    const s = await scenario('alias');
    const res = await setActive(s.orgId, false, platformAdmin, 'admin');

    expect(res.statusCode, res.body).toBe(200);
    expect(await isActive(s.orgId)).toBe(false);
  });

  it('refuses the organization that owns the default team, changing and closing nothing', async () => {
    const s = await scenario('default');
    const defaultSlug = name('the-default-team');
    process.env.DEFAULT_TEAM_SLUG = defaultSlug;
    await makeTeam('default-owner', s.orgId, defaultSlug);
    const requester = await requesterOf('default', outsideOrg);
    const open = await create(requester, (s.teams[0] as Scenario['teams'][number]).teamId);

    const res = await setActive(s.orgId, false);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DEFAULT_ORGANIZATION');
    expect(await isActive(s.orgId)).toBe(true);
    expect((await requestRow(open)).status).toBe('PENDING_TEAM');
    expect(await orgAudits(s.orgId)).toHaveLength(0);
  });

  it('answers 404 for an unknown organization', async () => {
    const res = await setActive(crypto.randomUUID(), false);

    expect(res.statusCode).toBe(404);
  });

  it('refuses everyone but a platform admin: an organization admin, a member and an outsider', async () => {
    const s = await scenario('refuse');
    const member = await requesterOf('refuse-member', s.orgId);
    const outsider = await requesterOf('refuse-outsider', null);
    const open = await create(
      await requesterOf('refuse-req', outsideOrg),
      (s.teams[0] as Scenario['teams'][number]).teamId
    );

    for (const caller of [s.orgAdmin, member]) {
      const res = await setActive(s.orgId, false, caller);
      expect(res.statusCode, `caller ${caller}`).toBe(403);
    }
    const adminRes = await patch(s.orgAdmin, s.orgId, { isActive: false, name: name('renamed') });
    expect(adminRes.statusCode).toBe(403);
    expect(adminRes.json().error).toMatchObject({
      code: 'FORBIDDEN',
      missing: 'platform.orgs.deactivate',
    });
    expect([403, 404]).toContain((await setActive(s.orgId, false, outsider)).statusCode);

    expect(await isActive(s.orgId)).toBe(true);
    expect((await requestRow(open)).status).toBe('PENDING_TEAM');
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: s.orgId } })).name).not.toBe(
      name('renamed')
    );
    expect(await orgAudits(s.orgId)).toHaveLength(0);

    // The organization admin's own rule is unchanged: a rename is theirs.
    const renamed = await patch(s.orgAdmin, s.orgId, { name: name('renamed-by-admin') });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });

  it('applies a rename sent with the flag in the same transaction, and rolls both back on a clash', async () => {
    const s = await scenario('combo');
    const other = await scenario('combo-other');
    const otherName = (await prisma.organization.findUniqueOrThrow({ where: { id: other.orgId } }))
      .name;
    const requester = await requesterOf('combo', outsideOrg);
    const open = await create(requester, (s.teams[0] as Scenario['teams'][number]).teamId);

    const clash = await patch(platformAdmin, s.orgId, { isActive: false, name: otherName });

    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('ORG_EXISTS');
    expect(await isActive(s.orgId)).toBe(true);
    expect((await requestRow(open)).status).toBe('PENDING_TEAM');
    expect(await orgAudits(s.orgId)).toHaveLength(0);

    const ok = await patch(platformAdmin, s.orgId, { isActive: false, name: name('combo-new') });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data).toMatchObject({ isActive: false, name: name('combo-new') });
    expect((await requestRow(open)).status).toBe('REJECTED');
  });

  describe('against an inactive organization', () => {
    it('answers a new request as for an unknown team, and the directory lists no team of it', async () => {
      const s = await scenario('inactive-create');
      const requester = await requesterOf('inactive-create', outsideOrg);
      const teamId = (s.teams[0] as Scenario['teams'][number]).teamId;
      const q = name('team-inactive-create');
      const visible = async () => {
        const dir = await loadDirectory(
          prisma,
          { role: 'USER', sub: requester },
          { limit: 100, q }
        );
        return dir.ok ? dir.teams.map((t) => t.id) : [];
      };
      expect(await visible()).toContain(teamId);

      await setActive(s.orgId, false);

      expect(await visible()).toEqual([]);
      const refused = await createJoinRequest(fastify, {
        actor: actorOf(requester),
        context: {},
        message: 'hi',
        teamId,
      });
      expect(refused).toMatchObject({ code: 'TEAM_NOT_FOUND', ok: false, status: 404 });
      const unknown = await createJoinRequest(fastify, {
        actor: actorOf(requester),
        context: {},
        message: 'hi',
        teamId: crypto.randomUUID(),
      });
      expect(unknown).toMatchObject({ code: 'TEAM_NOT_FOUND', ok: false, status: 404 });
      expect(await openIn(s.orgId)).toBe(0);
    });

    it('refuses the team step, rejection included, and leaves the request untouched', async () => {
      const s = await scenario('inactive-team');
      const team = s.teams[0] as Scenario['teams'][number];
      const requestId = await create(await requesterOf('inactive-team', s.orgId), team.teamId);
      await markInactive(s.orgId);
      const before = await requestRow(requestId);

      for (const decide of [teamApprove, teamReject]) {
        const out = await decide(team.lead, team.teamId, requestId);
        expect(out).toMatchObject({ code: 'ORGANIZATION_INACTIVE', ok: false, status: 409 });
      }

      expect(await requestRow(requestId)).toEqual(before);
      expect(await membershipCount(before.userId, team.teamId)).toBe(0);
      expect(
        await prisma.configAuditLog.count({ where: { action: 'UPDATE', entityId: requestId } })
      ).toBe(0);
    });

    it('refuses the combined approval, and makes no organization membership', async () => {
      const s = await scenario('inactive-combined');
      const team = s.teams[0] as Scenario['teams'][number];
      const requester = await requesterOf('inactive-combined', outsideOrg);
      const requestId = await create(requester, team.teamId);
      await markInactive(s.orgId);
      const before = await requestRow(requestId);

      // An organization admin holds both decisions, so this is the combined path.
      const out = await teamApprove(s.orgAdmin, team.teamId, requestId);

      expect(out).toMatchObject({ code: 'ORGANIZATION_INACTIVE', ok: false, status: 409 });
      expect(await requestRow(requestId)).toEqual(before);
      expect(await membershipCount(requester, team.teamId)).toBe(0);
      expect(
        await prisma.organizationMembership.count({ where: { orgId: s.orgId, userId: requester } })
      ).toBe(0);
    });

    it('refuses the organization step, rejection included, and leaves the request untouched', async () => {
      const s = await scenario('inactive-org');
      const waiting = await waitingForOrg(s, 'inactive-org');
      await markInactive(s.orgId);
      const before = await requestRow(waiting.requestId);

      for (const decide of [orgApprove, orgReject]) {
        const out = await decide(s.orgAdmin, s.orgId, waiting.requestId);
        expect(out).toMatchObject({ code: 'ORGANIZATION_INACTIVE', ok: false, status: 409 });
      }

      expect(await requestRow(waiting.requestId)).toEqual(before);
      expect(await membershipCount(waiting.requester, waiting.teamId)).toBe(0);
      expect(
        await prisma.organizationMembership.count({
          where: { orgId: s.orgId, userId: waiting.requester },
        })
      ).toBe(0);
    });

    it('still lets the requester withdraw', async () => {
      const s = await scenario('inactive-withdraw');
      const requester = await requesterOf('inactive-withdraw', outsideOrg);
      const requestId = await create(requester, (s.teams[0] as Scenario['teams'][number]).teamId);
      await markInactive(s.orgId);

      const out = await withdrawRequest(fastify, {
        actor: actorOf(requester),
        context: {},
        requestId,
      });

      expect(out).toMatchObject({ ok: true });
      expect((await requestRow(requestId)).status).toBe('WITHDRAWN');
    });

    it('decides again once the organization is reactivated', async () => {
      const s = await scenario('inactive-back');
      const team = s.teams[0] as Scenario['teams'][number];
      const requestId = await create(await requesterOf('inactive-back', s.orgId), team.teamId);
      await markInactive(s.orgId);
      expect(await teamApprove(team.lead, team.teamId, requestId)).toMatchObject({
        code: 'ORGANIZATION_INACTIVE',
      });
      await prisma.organization.update({ data: { isActive: true }, where: { id: s.orgId } });

      expect(await teamApprove(team.lead, team.teamId, requestId)).toMatchObject({ ok: true });
    });
  });

  describe('a deactivation racing a decision', () => {
    const ITERATIONS = 8;
    const refusedCodes = /ORGANIZATION_INACTIVE|REQUEST_ALREADY_DECIDED|JOIN_REQUEST_NOT_FOUND/;

    function expectSettled(
      label: string,
      outcome: { ok: boolean; code?: string },
      row: { closeReason: string | null; status: string },
      deactivated: { statusCode: number; body: string },
      members: number
    ) {
      expect(deactivated.statusCode, `${label}: ${deactivated.body}`).toBe(200);
      if (outcome.ok) {
        // The decision claimed the request first; the deactivation found nothing open there.
        expect(row, label).toMatchObject({ closeReason: null });
        expect(['APPROVED', 'REJECTED', 'PENDING_ORG'], label).toContain(row.status);
      } else {
        expect(outcome.code, label).toMatch(refusedCodes);
        expect(row, label).toMatchObject({
          closeReason: 'ORGANIZATION_DEACTIVATED',
          status: 'REJECTED',
        });
        expect(members, label).toBe(0);
      }
    }

    it('settles a team-step approval one way or the other, with nothing left open', async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const s = await scenario(`race-team-${i}`);
        const team = s.teams[0] as Scenario['teams'][number];
        const requester = await requesterOf(`race-team-${i}`, s.orgId);
        const requestId = await create(requester, team.teamId);

        const [outcome, deactivated] = await Promise.all([
          teamApprove(team.lead, team.teamId, requestId),
          setActive(s.orgId, false),
        ]);

        const row = await requestRow(requestId);
        expectSettled(
          `iteration ${i}`,
          outcome,
          row,
          deactivated,
          await membershipCount(requester, team.teamId)
        );
        if (outcome.ok) {
          expect(row.status).toBe('APPROVED');
          expect(await membershipCount(requester, team.teamId)).toBe(1);
        }
        expect(await openIn(s.orgId), `iteration ${i}`).toBe(0);
        expect(await isActive(s.orgId)).toBe(false);
      }
    }, 120_000);

    it('settles a team-step rejection one way or the other, with nothing left open', async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const s = await scenario(`race-reject-${i}`);
        const team = s.teams[0] as Scenario['teams'][number];
        const requestId = await create(await requesterOf(`race-reject-${i}`, s.orgId), team.teamId);

        const [outcome, deactivated] = await Promise.all([
          teamReject(team.lead, team.teamId, requestId),
          setActive(s.orgId, false),
        ]);

        expect(deactivated.statusCode, deactivated.body).toBe(200);
        const row = await requestRow(requestId);
        expect(row.status).toBe('REJECTED');
        if (outcome.ok) {
          expect(row.closeReason, `iteration ${i}`).toBeNull();
        } else {
          expect(outcome).toMatchObject({ code: expect.stringMatching(refusedCodes) });
          expect(row.closeReason, `iteration ${i}`).toBe('ORGANIZATION_DEACTIVATED');
        }
        expect(await openIn(s.orgId), `iteration ${i}`).toBe(0);
      }
    }, 120_000);

    it('settles an organization-step approval one way or the other, with nothing left open', async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const s = await scenario(`race-org-${i}`);
        const waiting = await waitingForOrg(s, `race-org-${i}`);

        const [outcome, deactivated] = await Promise.all([
          orgApprove(s.orgAdmin, s.orgId, waiting.requestId),
          setActive(s.orgId, false),
        ]);

        const row = await requestRow(waiting.requestId);
        expectSettled(
          `iteration ${i}`,
          outcome,
          row,
          deactivated,
          await membershipCount(waiting.requester, waiting.teamId)
        );
        if (outcome.ok) {
          expect(row.status).toBe('APPROVED');
          expect(await membershipCount(waiting.requester, waiting.teamId)).toBe(1);
        }
        expect(await openIn(s.orgId), `iteration ${i}`).toBe(0);
      }
    }, 120_000);

    it('settles a creation one way or the other, never leaving a request open', async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const s = await scenario(`race-create-${i}`);
        const team = s.teams[0] as Scenario['teams'][number];
        const requester = await requesterOf(`race-create-${i}`, outsideOrg);

        const [made, deactivated] = await Promise.all([
          createJoinRequest(fastify, {
            actor: actorOf(requester),
            context: {},
            message: 'hi',
            teamId: team.teamId,
          }),
          setActive(s.orgId, false),
        ]);

        expect(deactivated.statusCode, deactivated.body).toBe(200);
        if (made.ok) {
          expect(await requestRow(made.request.id), `iteration ${i}`).toMatchObject({
            closeReason: 'ORGANIZATION_DEACTIVATED',
            status: 'REJECTED',
          });
        } else {
          expect(made, `iteration ${i}`).toMatchObject({ code: 'TEAM_NOT_FOUND', status: 404 });
        }
        expect(await openIn(s.orgId), `iteration ${i}`).toBe(0);
      }
    }, 120_000);

    it('settles two deactivations of the same organization, closing each request once', async () => {
      const s = await scenario('race-twice');
      const requestId = await create(
        await requesterOf('race-twice', outsideOrg),
        (s.teams[0] as Scenario['teams'][number]).teamId
      );

      const [first, second] = await Promise.all([
        setActive(s.orgId, false),
        setActive(s.orgId, false),
      ]);

      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect((await requestRow(requestId)).closeReason).toBe('ORGANIZATION_DEACTIVATED');
      expect(await orgAudits(s.orgId)).toHaveLength(1);
      expect(
        await prisma.configAuditLog.count({
          where: { action: 'UPDATE', entityId: requestId, entityType: 'TeamJoinRequest' },
        })
      ).toBe(1);
    });
  });
});
