import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import {
  invalidateSettingsCache,
  resolveSetting,
  resolveSettingForOrganizations,
} from '@auto-swe/shared/config';
import { _cacheSizeForTests } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '../plugins/auth.js';
import { orgMembersRoutes } from '../routes/orgMembers.js';
import { createTeam, TeamLimitReached, teamRoutes } from '../routes/teams.js';
import { userRoutes } from '../routes/users.js';
import {
  approveAtOrgStep,
  approveAtTeamStep,
  closeOpenJoinRequests,
  createJoinRequest,
  DIRECTORY_ORGANIZATIONS_LIMIT,
  listOrgRequests,
  listOwnRequests,
  listTeamRequests,
  loadDirectory,
  rejectAtTeamStep,
  withdrawRequest,
} from './teamJoinRequests.js';

/**
 * Join requests against real Postgres: the partial unique index that allows one open request per
 * user and team, the claim (a conditional update on the expected status) that lets exactly one of
 * two concurrent decisions win, the per-person lock that holds the open-request cap under
 * concurrency, and the whole two-step approval. Each is a database property a mocked Prisma only
 * imitates. Every query here also runs through the real tenant guard, so a mass query without a
 * tenant predicate or an `runUnscoped` mark fails here and not in production.
 *
 * The deactivation, organization-removal and team-creation paths run through the real route
 * plugins over the same database, so the transaction that deactivates something is the one that
 * closes its requests.
 *
 * Opt in with `TEAM_JOIN_REQUESTS_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.TEAM_JOIN_REQUESTS_PG_TEST === '1';

describe.skipIf(!enabled)('team join requests against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const name = (label: string) => `jr-${suffix}-${label}`;
  // `writeAuditLog` is given the transaction client every time, so the app needs only `prisma`.
  const fastify = { prisma } as unknown as FastifyInstance;
  const ctx = {};
  const orgIds: string[] = [];
  const teamIds: string[] = [];
  const userIds: string[] = [];

  const actorOf = (id: string): JwtPayload => ({ exp: 0, iat: 0, role: 'USER', sub: id });

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
  async function makeTeam(label: string, orgId: string) {
    const team = await prisma.team.create({
      data: { name: name(`team-${label}`), orgId, slug: name(`team-${label}`) },
    });
    teamIds.push(team.id);
    return team.id;
  }
  const inOrg = (userId: string, orgId: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') =>
    prisma.organizationMembership.create({ data: { orgId, role, userId } });
  const onTeam = (userId: string, teamId: string, role: 'ADMIN' | 'LEAD' | 'MEMBER') =>
    prisma.teamMembership.create({ data: { role, teamId, userId } });

  let orgA: string;
  let orgB: string;
  let lead: string;
  let admin: string;
  let orgAdmin: string;
  let orgAdmin2: string;
  let platformAdmin: string;
  let app: FastifyInstance;

  /** The GLOBAL `teams.directoryScope` rows the database held before this suite, put back at the end. */
  let originalDirectoryScope: Array<{ value: unknown }> = [];

  beforeAll(async () => {
    originalDirectoryScope = await runUnscoped(
      'test: remember the platform-wide directory scope',
      ['ConfigSetting'],
      () =>
        prisma.configSetting.findMany({
          select: { value: true },
          where: { key: 'teams.directoryScope', scope: 'GLOBAL' },
        })
    );
    orgA = await makeOrg('a');
    orgB = await makeOrg('b');
    lead = await makeUser('lead');
    admin = await makeUser('admin');
    orgAdmin = await makeUser('org-admin');
    orgAdmin2 = await makeUser('org-admin-2');
    platformAdmin = await makeUser('platform-admin');
    await inOrg(lead, orgA);
    await inOrg(admin, orgA);
    await inOrg(orgAdmin, orgA, 'ADMIN');
    await inOrg(orgAdmin2, orgA, 'ADMIN');

    // The real route plugins, authenticated by the token being the caller's user id.
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
    await app.register(userRoutes, { prefix: '/api/v1/users' });
    await app.register(teamRoutes, { prefix: '/api/v1/teams' });
    await app.register(orgMembersRoutes, { prefix: '/api/v1/platform/organizations' });
    await app.ready();
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
      where: { actorId: { in: userIds } },
    });
    await runUnscoped(
      'test: restore the platform-wide directory scope',
      ['ConfigSetting'],
      async () => {
        await prisma.configSetting.deleteMany({
          where: { key: 'teams.directoryScope', scope: 'GLOBAL' },
        });
        await prisma.configSetting.createMany({
          data: originalDirectoryScope.map((r) => ({
            key: 'teams.directoryScope',
            scope: 'GLOBAL' as const,
            value: r.value as never,
          })),
        });
      }
    );
    invalidateSettingsCache();
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  /** A team in org A with `lead` on it, and a requester in org A who is not. */
  async function scenario(label: string, requesterOrg: string | null = orgA) {
    const teamId = await makeTeam(label, orgA);
    await onTeam(lead, teamId, 'LEAD');
    await onTeam(admin, teamId, 'ADMIN');
    const requester = await makeUser(`req-${label}`);
    if (requesterOrg) {
      await inOrg(requester, requesterOrg);
    }
    return { requester, teamId };
  }

  const create = (userId: string, teamId: string) =>
    createJoinRequest(fastify, { actor: actorOf(userId), context: ctx, message: 'hi', teamId });
  const approve = (reviewer: string, teamId: string, requestId: string, role?: 'LEAD') =>
    approveAtTeamStep(fastify, { actor: actorOf(reviewer), context: ctx, requestId, role, teamId });

  const membershipCount = (userId: string, teamId: string) =>
    prisma.teamMembership.count({ where: { teamId, userId } });

  it('allows one open request per user and team, and a new one after the first is final', async () => {
    const { requester, teamId } = await scenario('unique');
    const first = await create(requester, teamId);
    expect(first.ok).toBe(true);
    // Straight to the table, past the service's pre-check: the partial unique index decides.
    await expect(
      prisma.teamJoinRequest.create({ data: { teamId, userId: requester } })
    ).rejects.toMatchObject({ code: 'P2002' });
    const again = await create(requester, teamId);
    expect(again).toMatchObject({ code: 'REQUEST_PENDING', ok: false, status: 409 });

    if (!first.ok) {
      return;
    }
    await withdrawRequest(fastify, {
      actor: actorOf(requester),
      context: ctx,
      requestId: first.request.id,
    });
    await expect(
      prisma.teamJoinRequest.create({ data: { teamId, userId: requester } })
    ).resolves.toBeTruthy();
  });

  it('lets exactly one of two concurrent approvals win and creates one membership', async () => {
    const { requester, teamId } = await scenario('race');
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    const results = await Promise.all([
      approve(lead, teamId, created.request.id),
      approve(admin, teamId, created.request.id),
      approve(orgAdmin, teamId, created.request.id),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const loser of results.filter((r) => !r.ok)) {
      expect(loser).toMatchObject({ code: 'REQUEST_ALREADY_DECIDED', status: 409 });
    }
    expect(await membershipCount(requester, teamId)).toBe(1);
    const audited = await prisma.configAuditLog.count({
      where: {
        action: 'CREATE',
        actorId: { in: [lead, admin, orgAdmin] },
        entityType: 'TeamMembership',
      },
    });
    expect(audited).toBeGreaterThanOrEqual(1);
  });

  it('lets exactly one of an approval and a rejection win', async () => {
    const { requester, teamId } = await scenario('approve-reject');
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    const [approved, rejected] = await Promise.all([
      approve(lead, teamId, created.request.id),
      rejectAtTeamStep(fastify, {
        actor: actorOf(admin),
        context: ctx,
        requestId: created.request.id,
        teamId,
      }),
    ]);
    expect([approved.ok, rejected.ok].filter(Boolean)).toHaveLength(1);
    const row = await prisma.teamJoinRequest.findUniqueOrThrow({
      where: { id: created.request.id },
    });
    expect(row.status).toBe(approved.ok ? 'APPROVED' : 'REJECTED');
    expect(await membershipCount(requester, teamId)).toBe(approved.ok ? 1 : 0);
  });

  it('lets exactly one of an approval and a withdrawal win', async () => {
    const { requester, teamId } = await scenario('approve-withdraw');
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    const [approved, withdrawn] = await Promise.all([
      approve(lead, teamId, created.request.id),
      withdrawRequest(fastify, {
        actor: actorOf(requester),
        context: ctx,
        requestId: created.request.id,
      }),
    ]);
    expect([approved.ok, withdrawn.ok].filter(Boolean)).toHaveLength(1);
    expect(await membershipCount(requester, teamId)).toBe(approved.ok ? 1 : 0);
  });

  it('holds the open-request cap against concurrent requests from one person', async () => {
    const orgId = await makeOrg('cap');
    const requester = await makeUser('capper');
    await inOrg(requester, orgId);
    // The default cap is 5; seven teams ask for seven concurrent requests.
    const ids = await Promise.all(Array.from({ length: 7 }, (_, i) => makeTeam(`cap-${i}`, orgId)));
    const results = await Promise.all(ids.map((id) => create(requester, id)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.code === 'TOO_MANY_OPEN_REQUESTS')).toHaveLength(2);
    const open = await runUnscoped(
      'test: count the caller’s open requests',
      ['TeamJoinRequest'],
      () =>
        prisma.teamJoinRequest.count({
          where: { status: { in: ['PENDING_TEAM', 'PENDING_ORG'] }, userId: requester },
        })
    );
    expect(open).toBe(5);
  });

  it('takes a cross-organization request through both steps in one transaction each', async () => {
    const { requester, teamId } = await scenario('cross', orgB);
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    expect(created.request.requiresOrgApproval).toBe(true);

    // The organization cannot decide before the team has.
    const early = await approveAtOrgStep(fastify, {
      actor: actorOf(orgAdmin),
      context: ctx,
      orgId: orgA,
      requestId: created.request.id,
    });
    expect(early).toMatchObject({ code: 'REQUEST_ALREADY_DECIDED', ok: false });

    const teamStep = await approve(lead, teamId, created.request.id, 'LEAD');
    expect(teamStep.ok && teamStep.request.status).toBe('PENDING_ORG');
    expect(await membershipCount(requester, teamId)).toBe(0);

    const queue = await listOrgRequests(prisma, orgA, 'PENDING_ORG', 100);
    expect(queue.map((r) => r.id)).toContain(created.request.id);

    const orgStep = await approveAtOrgStep(fastify, {
      actor: actorOf(orgAdmin),
      context: ctx,
      orgId: orgA,
      requestId: created.request.id,
    });
    expect(orgStep.ok && orgStep.request.status).toBe('APPROVED');
    const team = await prisma.teamMembership.findUniqueOrThrow({
      where: { userId_teamId: { teamId, userId: requester } },
    });
    expect(team.role).toBe('LEAD');
    await expect(
      prisma.organizationMembership.findUniqueOrThrow({
        where: { userId_orgId: { orgId: orgA, userId: requester } },
      })
    ).resolves.toMatchObject({ role: 'MEMBER' });
    const audited = await prisma.configAuditLog.findMany({
      select: { entityType: true },
      where: { actorId: orgAdmin },
    });
    expect(audited.map((a) => a.entityType)).toEqual(
      expect.arrayContaining(['OrganizationMembership', 'TeamMembership', 'TeamJoinRequest'])
    );
  });

  it('does not duplicate a membership the requester already holds', async () => {
    const { requester, teamId } = await scenario('already');
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    await onTeam(requester, teamId, 'MEMBER');
    const done = await approve(lead, teamId, created.request.id);
    expect(done.ok && done.request.status).toBe('APPROVED');
    expect(await membershipCount(requester, teamId)).toBe(1);
  });

  it('refuses to approve for a requester who has been deactivated', async () => {
    const { requester, teamId } = await scenario('inactive');
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    await prisma.user.update({ data: { isActive: false }, where: { id: requester } });
    const done = await approve(lead, teamId, created.request.id);
    expect(done).toMatchObject({ code: 'REQUESTER_INACTIVE', ok: false, status: 409 });
    expect(await membershipCount(requester, teamId)).toBe(0);
  });

  it('runs the directory and the listings through the tenant guard', async () => {
    const { requester, teamId } = await scenario('listing');
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    const directory = await loadDirectory(
      prisma,
      { role: 'USER', sub: requester },
      {
        limit: 100,
        q: name('team-listing'),
      }
    );
    expect(directory.ok && directory.teams).toMatchObject([
      { id: teamId, memberCount: 2, relationship: 'REQUESTED', requestId: created.request.id },
    ]);
    expect((await listOwnRequests(prisma, requester)).requests.map((r) => r.id)).toEqual([
      created.request.id,
    ]);
    expect((await listTeamRequests(prisma, teamId, 'PENDING_TEAM', 10)).map((r) => r.id)).toEqual([
      created.request.id,
    ]);
  });

  /* ── Follow-up: organization step, combined approval, clamp ─────────────── */

  const actAs = (id: string) => ({ authorization: `Bearer ${id}` });
  const orgStep = (reviewer: string, requestId: string, orgId = orgA) =>
    approveAtOrgStep(fastify, { actor: actorOf(reviewer), context: ctx, orgId, requestId });
  const requestRow = (id: string) =>
    runUnscoped('test: read one request', ['TeamJoinRequest'], () =>
      prisma.teamJoinRequest.findUniqueOrThrow({ where: { id } })
    );
  const auditsOf = (entityId: string) =>
    prisma.configAuditLog.findMany({ orderBy: { createdAt: 'asc' }, where: { entityId } });

  /** A request from outside orgA to a team led by a fresh lead, approved at the team step with `role`. */
  async function waitingForOrg(label: string, role: 'ADMIN' | 'LEAD' = 'LEAD') {
    const teamId = await makeTeam(label, orgA);
    const leader = await makeUser(`leader-${label}`);
    await inOrg(leader, orgA);
    await onTeam(leader, teamId, role === 'ADMIN' ? 'ADMIN' : 'LEAD');
    const requester = await makeUser(`req-${label}`);
    await inOrg(requester, orgB);
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    const decided = await approveAtTeamStep(fastify, {
      actor: actorOf(leader),
      context: ctx,
      requestId: created.request.id,
      role,
      teamId,
    });
    expect(decided.ok && decided.request.status).toBe('PENDING_ORG');
    return { leader, requester, requestId: created.request.id, teamId };
  }

  it('lets exactly one of two concurrent organization-step approvals win', async () => {
    const { requestId, requester, teamId } = await waitingForOrg('org-race');
    const results = await Promise.all([
      orgStep(orgAdmin, requestId),
      orgStep(orgAdmin2, requestId),
      orgStep(orgAdmin, requestId),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const loser of results.filter((r) => !r.ok)) {
      expect(loser).toMatchObject({ code: 'REQUEST_ALREADY_DECIDED', status: 409 });
    }
    expect(await membershipCount(requester, teamId)).toBe(1);
    expect(
      await prisma.organizationMembership.count({ where: { orgId: orgA, userId: requester } })
    ).toBe(1);
  });

  it('records both decisions in one transaction when the team approver is an organization admin', async () => {
    const { requester, teamId } = await scenario('combined', orgB);
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    const done = await approve(orgAdmin, teamId, created.request.id);
    expect(done.ok && done.request.status).toBe('APPROVED');
    expect(await membershipCount(requester, teamId)).toBe(1);
    await expect(
      prisma.organizationMembership.findUniqueOrThrow({
        where: { userId_orgId: { orgId: orgA, userId: requester } },
      })
    ).resolves.toMatchObject({ role: 'MEMBER' });
    const row = await requestRow(created.request.id);
    expect(row).toMatchObject({
      orgDecidedById: orgAdmin,
      requiresOrgApproval: true,
      status: 'APPROVED',
      teamDecidedById: orgAdmin,
    });
    const rows = await auditsOf(created.request.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.afterJson).toMatchObject({
      combinedDecision: {
        authority: { organization: 'org-admin' },
        steps: ['team', 'organization'],
      },
    });
    const orgRows = await prisma.configAuditLog.findMany({
      where: { actorId: orgAdmin, entityType: 'OrganizationMembership' },
    });
    expect(
      orgRows.some((r) => (r.context as { authority?: string } | null)?.authority === 'org-admin')
    ).toBe(true);
  });

  it('leaves the request at the organization step when the approver is only a team lead', async () => {
    const { requester, teamId } = await scenario('not-combined', orgB);
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    const done = await approve(lead, teamId, created.request.id);
    expect(done.ok && done.request.status).toBe('PENDING_ORG');
    expect(await membershipCount(requester, teamId)).toBe(0);
    expect(
      await prisma.organizationMembership.count({ where: { orgId: orgA, userId: requester } })
    ).toBe(0);
  });

  it('clamps the granted role to MEMBER when the team approver was deactivated meanwhile', async () => {
    const { leader, requestId, requester, teamId } = await waitingForOrg('clamp-inactive');
    await prisma.user.update({ data: { isActive: false }, where: { id: leader } });
    const done = await orgStep(orgAdmin, requestId);
    expect(done.ok && done.request).toMatchObject({ grantedRole: 'MEMBER', status: 'APPROVED' });
    const team = await prisma.teamMembership.findUniqueOrThrow({
      where: { userId_teamId: { teamId, userId: requester } },
    });
    expect(team.role).toBe('MEMBER');
    const audit = (await auditsOf(requestId)).at(-1);
    expect(audit?.afterJson).toMatchObject({
      clamp: { clamped: true, from: 'LEAD', to: 'MEMBER' },
    });
  });

  it('clamps when the team approver was demoted or removed, and keeps the role when nothing changed', async () => {
    const demoted = await waitingForOrg('clamp-demoted');
    await prisma.teamMembership.updateMany({
      data: { role: 'MEMBER' },
      where: { teamId: demoted.teamId, userId: demoted.leader },
    });
    await orgStep(orgAdmin, demoted.requestId);
    expect(
      (
        await prisma.teamMembership.findUniqueOrThrow({
          where: { userId_teamId: { teamId: demoted.teamId, userId: demoted.requester } },
        })
      ).role
    ).toBe('MEMBER');

    const removed = await waitingForOrg('clamp-removed');
    await prisma.teamMembership.deleteMany({
      where: { teamId: removed.teamId, userId: removed.leader },
    });
    await orgStep(orgAdmin, removed.requestId);
    expect((await auditsOf(removed.requestId)).at(-1)?.afterJson).toMatchObject({
      clamp: { clamped: true, from: 'LEAD', to: 'MEMBER' },
    });

    const intact = await waitingForOrg('clamp-intact');
    await orgStep(orgAdmin, intact.requestId);
    expect(
      (
        await prisma.teamMembership.findUniqueOrThrow({
          where: { userId_teamId: { teamId: intact.teamId, userId: intact.requester } },
        })
      ).role
    ).toBe('LEAD');
    expect((await auditsOf(intact.requestId)).at(-1)?.afterJson).toMatchObject({
      clamp: { clamped: false, from: 'LEAD', to: 'LEAD' },
    });
  });

  /* ── Follow-up: cooldowns ──────────────────────────────────────────────── */

  it('starts a cooldown when the requester withdraws, and names it', async () => {
    const { requester, teamId } = await scenario('withdraw-cooldown');
    const first = await create(requester, teamId);
    if (!first.ok) {
      throw new Error('setup failed');
    }
    await withdrawRequest(fastify, {
      actor: actorOf(requester),
      context: ctx,
      requestId: first.request.id,
    });
    const again = await create(requester, teamId);
    expect(again).toMatchObject({
      code: 'JOIN_REQUEST_COOLDOWN',
      details: { reason: 'withdrawn' },
      ok: false,
      status: 429,
    });
    expect(again.ok === false && again.retryAfterSeconds).toBeGreaterThan(0);
    expect(again.ok === false && again.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it('names a rejection as the reason when a person rejected', async () => {
    const { requester, teamId } = await scenario('reject-cooldown');
    const first = await create(requester, teamId);
    if (!first.ok) {
      throw new Error('setup failed');
    }
    await rejectAtTeamStep(fastify, {
      actor: actorOf(lead),
      context: ctx,
      requestId: first.request.id,
      teamId,
    });
    expect(await create(requester, teamId)).toMatchObject({
      code: 'JOIN_REQUEST_COOLDOWN',
      details: { reason: 'rejected' },
      status: 429,
    });
  });

  /* ── Follow-up: deactivation closes open requests ──────────────────────── */

  it('closes a deactivated user’s open requests in the deactivation, with audit, and starts no cooldown', async () => {
    const requester = await makeUser('deact-user');
    await inOrg(requester, orgB);
    const t1 = await makeTeam('deact-user-1', orgA);
    const t2 = await makeTeam('deact-user-2', orgA);
    await onTeam(lead, t1, 'LEAD');
    await onTeam(lead, t2, 'LEAD');
    const r1 = await create(requester, t1);
    const r2 = await create(requester, t2);
    if (!(r1.ok && r2.ok)) {
      throw new Error('setup failed');
    }
    // One at each step.
    await approve(lead, t2, r2.request.id);
    expect((await requestRow(r2.request.id)).status).toBe('PENDING_ORG');

    const res = await app.inject({
      headers: actAs(platformAdmin),
      method: 'PATCH',
      payload: { isActive: false },
      url: `/api/v1/users/${requester}`,
    });
    expect(res.statusCode, res.body).toBe(200);

    for (const [id, field] of [
      [r1.request.id, 'teamDecisionNote'],
      [r2.request.id, 'orgDecisionNote'],
    ] as const) {
      const row = await requestRow(id);
      expect(row).toMatchObject({ closeReason: 'REQUESTER_DEACTIVATED', status: 'WITHDRAWN' });
      expect(row[field]).toBe('Closed automatically: the requester was deactivated.');
      const audit = (await auditsOf(id)).at(-1);
      expect(audit).toMatchObject({ action: 'UPDATE', actorId: platformAdmin });
      expect(audit?.afterJson).toMatchObject({
        closeReason: 'REQUESTER_DEACTIVATED',
        systemClose: true,
      });
    }
    expect(await membershipCount(requester, t1)).toBe(0);

    // Reactivation reopens nothing and there is no cooldown to wait out.
    await prisma.user.update({ data: { isActive: true }, where: { id: requester } });
    expect((await requestRow(r1.request.id)).status).toBe('WITHDRAWN');
    expect((await create(requester, t1)).ok).toBe(true);
  });

  it('closes a deactivated team’s open requests as a rejection, with no cooldown', async () => {
    const { requester, teamId } = await scenario('deact-team');
    const outsider = await makeUser('deact-team-out');
    await inOrg(outsider, orgB);
    const a = await create(requester, teamId);
    const b = await create(outsider, teamId);
    if (!(a.ok && b.ok)) {
      throw new Error('setup failed');
    }
    await approve(lead, teamId, b.request.id); // outsider: now awaiting the organization

    const res = await app.inject({
      headers: actAs(platformAdmin),
      method: 'DELETE',
      url: `/api/v1/teams/${teamId}`,
    });
    expect(res.statusCode, res.body).toBe(200);

    for (const id of [a.request.id, b.request.id]) {
      expect(await requestRow(id)).toMatchObject({
        closeReason: 'TEAM_DEACTIVATED',
        status: 'REJECTED',
      });
    }
    expect((await requestRow(a.request.id)).teamDecisionNote).toBe(
      'Closed automatically: the team was deactivated.'
    );
    expect((await requestRow(b.request.id)).orgDecisionNote).toBe(
      'Closed automatically: the team was deactivated.'
    );
    expect((await auditsOf(a.request.id)).at(-1)?.afterJson).toMatchObject({
      closeReason: 'TEAM_DEACTIVATED',
      systemClose: true,
    });
    // The team comes back: the same people may ask at once.
    await runUnscoped('test fixture: reactivate', ['Team'], () =>
      prisma.team.update({ data: { isActive: true }, where: { id: teamId } })
    );
    expect((await create(requester, teamId)).ok).toBe(true);
  });

  it('closes every open request of a deactivated organization, and only that organization’s', async () => {
    const orgId = await makeOrg('deact-org');
    const tA = await makeTeam('deact-org-a', orgId);
    const tB = await makeTeam('deact-org-b', orgId);
    const requester = await makeUser('deact-org-req');
    await inOrg(requester, orgId);
    const other = await scenario('deact-org-other');
    const mine = await Promise.all([create(requester, tA), create(requester, tB)]);
    const elsewhere = await create(other.requester, other.teamId);
    if (!(mine.every((r) => r.ok) && elsewhere.ok)) {
      throw new Error('setup failed');
    }
    // What `PATCH /platform/organizations/:orgId` does in one transaction, written out here: the
    // flag flips and the organization's open requests close together. The route itself, the
    // organization lock and the races are exercised in `organizationDeactivation.pg.test.ts`; this
    // case is about what the close leaves behind (the closed rows and the absent cooldown).
    const closed = await prisma.$transaction(async (tx) => {
      await tx.organization.update({ data: { isActive: false }, where: { id: orgId } });
      return closeOpenJoinRequests(fastify, tx, {
        actor: actorOf(platformAdmin),
        scope: { orgId, reason: 'ORGANIZATION_DEACTIVATED' },
      });
    });
    expect(closed).toBe(2);
    for (const r of mine) {
      if (r.ok) {
        expect(await requestRow(r.request.id)).toMatchObject({
          closeReason: 'ORGANIZATION_DEACTIVATED',
          status: 'REJECTED',
        });
      }
    }
    expect((await requestRow(elsewhere.request.id)).status).toBe('PENDING_TEAM');
    // Back in an active organization the person is not held to a cooldown.
    await prisma.organization.update({ data: { isActive: true }, where: { id: orgId } });
    expect((await create(requester, tA)).ok).toBe(true);
  });

  it('settles a deactivation racing an approval one way or the other, never both', async () => {
    for (let i = 0; i < 5; i += 1) {
      const { requester, teamId } = await scenario(`deact-race-${i}`);
      const created = await create(requester, teamId);
      if (!created.ok) {
        throw new Error('setup failed');
      }
      const [approved, deleted] = await Promise.all([
        approve(lead, teamId, created.request.id),
        app.inject({
          headers: actAs(platformAdmin),
          method: 'DELETE',
          url: `/api/v1/teams/${teamId}`,
        }),
      ]);
      expect(deleted.statusCode).toBe(200);
      const row = await requestRow(created.request.id);
      if (approved.ok) {
        // The approval claimed the request first; the deactivation found nothing open.
        expect(row).toMatchObject({ closeReason: null, status: 'APPROVED' });
        expect(await membershipCount(requester, teamId)).toBe(1);
      } else {
        expect(approved).toMatchObject({
          code: expect.stringMatching(/TEAM_INACTIVE|REQUEST_ALREADY_DECIDED/),
        });
        expect(row).toMatchObject({ closeReason: 'TEAM_DEACTIVATED', status: 'REJECTED' });
        expect(await membershipCount(requester, teamId)).toBe(0);
      }
    }
  });

  /* ── Follow-up: the directory per organization ─────────────────────────── */

  it('lists a team by its own organization’s directory scope', async () => {
    const priv = await makeOrg('dir-priv');
    const pub = await makeOrg('dir-pub');
    // The organization asks for `organization` while the platform value stays `platform`.
    await prisma.configSetting.create({
      data: {
        key: 'teams.directoryScope',
        orgId: priv,
        scope: 'ORGANIZATION',
        value: 'organization',
      },
    });
    // The settings route does this on every save; a direct write has to say it itself.
    invalidateSettingsCache();
    const tPriv = await makeTeam('dirscope-priv', priv);
    const tPub = await makeTeam('dirscope-pub', pub);
    const inPub = await makeUser('dir-in-pub');
    const inPriv = await makeUser('dir-in-priv');
    await inOrg(inPub, pub);
    await inOrg(inPriv, priv);

    const list = async (viewer: string) => {
      const result = await loadDirectory(
        prisma,
        { role: 'USER', sub: viewer },
        { limit: 100, q: name('team-dirscope') }
      );
      if (!result.ok) {
        throw new Error('directory failed');
      }
      return result;
    };
    const fromPub = await list(inPub);
    expect(fromPub.teams.map((t) => t.id)).toEqual([tPub]);
    // The filter lists organizations with a visible team, whatever the search says.
    const orgNames = fromPub.organizations.map((o) => o.id);
    expect(orgNames).toContain(pub);
    expect(orgNames).not.toContain(priv);
    expect(fromPub.organizations.map((o) => o.name)).toEqual(
      [...fromPub.organizations.map((o) => o.name)].sort((a, b) => a.localeCompare(b))
    );

    const fromPriv = await list(inPriv);
    expect(fromPriv.teams.map((t) => t.id).sort()).toEqual([tPriv, tPub].sort());
    expect(fromPriv.organizations.map((o) => o.id)).toEqual(expect.arrayContaining([priv, pub]));

    // The same rule gates a request, with the answer an unknown team gets.
    expect(await create(inPub, tPriv)).toMatchObject({ code: 'TEAM_NOT_FOUND', status: 404 });
    expect((await create(inPriv, tPriv)).ok).toBe(true);
    expect((await create(inPriv, tPub)).ok).toBe(true);
  });

  /* ── Follow-up: self-service team creation ─────────────────────────────── */

  it('creates exactly the capped number of teams under concurrent self-service creation', async () => {
    const orgId = await makeOrg('selfservice');
    const creator = await makeUser('creator');
    await inOrg(creator, orgId);
    const cap = 3;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        createTeam(
          fastify,
          actorOf(creator),
          { description: '', name: name(`ss-${i}`), slug: name(`ss-${i}`) },
          orgId,
          ctx,
          { limit: cap }
        )
      )
    );
    const created = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(created).toHaveLength(cap);
    expect(refused).toHaveLength(8 - cap);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(TeamLimitReached);
    }
    const mine = await runUnscoped('test: the creator’s teams', ['Team'], () =>
      prisma.team.findMany({ where: { createdById: creator, isActive: true } })
    );
    expect(mine).toHaveLength(cap);
  });

  it('sets createdById only on the self-service path', async () => {
    const orgId = await makeOrg('creator-id');
    const person = await makeUser('creator-id');
    await inOrg(person, orgId);
    const viaAdmin = await createTeam(
      fastify,
      actorOf(person),
      { description: '', name: name('ci-admin'), slug: name('ci-admin') },
      orgId,
      ctx
    );
    const viaSelf = await createTeam(
      fastify,
      actorOf(person),
      { description: '', name: name('ci-self'), slug: name('ci-self') },
      orgId,
      ctx,
      { limit: 3 }
    );
    expect(viaAdmin.createdById).toBeNull();
    expect(viaSelf.createdById).toBe(person);
    // The administrator path never counts toward the cap.
    const stored = await runUnscoped('test: read teams', ['Team'], () =>
      prisma.team.findMany({ where: { id: { in: [viaAdmin.id, viaSelf.id] } } })
    );
    expect(stored.find((t) => t.id === viaAdmin.id)?.createdById).toBeNull();
  });

  /* ── Follow-up: an organization removal racing an approval ─────────────── */

  it('leaves no team membership behind when an organization removal races an approval', async () => {
    for (let i = 0; i < 6; i += 1) {
      const { requester, teamId } = await scenario(`cascade-${i}`);
      const created = await create(requester, teamId);
      if (!created.ok) {
        throw new Error('setup failed');
      }
      const [removal] = await Promise.all([
        app.inject({
          headers: actAs(orgAdmin),
          method: 'DELETE',
          url: `/api/v1/platform/organizations/${orgA}/members/${requester}`,
        }),
        approve(lead, teamId, created.request.id),
      ]);
      expect(removal.statusCode, removal.body).toBe(204);
      // Whichever came first, the person is out of the organization and out of its team.
      expect(
        await prisma.organizationMembership.count({ where: { orgId: orgA, userId: requester } })
      ).toBe(0);
      expect(await membershipCount(requester, teamId)).toBe(0);
    }
  });

  /* ── Review fixes: authority is decided under the locks ────────────────── */

  /**
   * A transaction that holds the organization's row lock, as an organization removal does, and
   * removes `userId`'s memberships under it; it commits when `commit()` is called.
   */
  async function holdingOrgLock(
    orgId: string,
    remove: (tx: Prisma.TransactionClient) => Promise<unknown>
  ) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let pid = 0;
    const held = prisma.$transaction(async (tx) => {
      pid = await backendPid(tx);
      // CLAUDE.md §7 exception: stands in for the organization removal's row lock.
      await tx.$executeRaw`SELECT 1 FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
      await runUnscoped(
        'test: a removal under the lock',
        ['OrganizationMembership', 'TeamMembership'],
        () => remove(tx)
      );
      locked();
      await gate;
    });
    await hasLock;
    return {
      commit: async () => {
        release();
        await held;
      },
      pid,
    };
  }

  /** The database backend serving this transaction. */
  async function backendPid(tx: Prisma.TransactionClient): Promise<number> {
    // CLAUDE.md §7 exception: reads the server's own backend id, not application data.
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
    return row?.pid ?? 0;
  }

  /** The backends waiting on a lock of the given kind that `holderPid` holds. */
  async function blockedBehind(holderPid: number, kind: 'advisory' | 'row'): Promise<number[]> {
    // CLAUDE.md §7 exception: reads the server's own lock-wait state, not application data. A row
    // or transaction lock is waited on as `transactionid` or `tuple`; an advisory one as `advisory`.
    const rows =
      kind === 'advisory'
        ? await prisma.$queryRaw<Array<{ pid: number }>>`
            SELECT a.pid::int AS pid FROM pg_stat_activity a
            WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
              AND a.wait_event_type = 'Lock' AND a.wait_event = 'advisory'
              AND ${holderPid}::int = ANY (pg_blocking_pids(a.pid))`
        : await prisma.$queryRaw<Array<{ pid: number }>>`
            SELECT a.pid::int AS pid FROM pg_stat_activity a
            WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
              AND a.wait_event_type = 'Lock' AND a.wait_event IN ('transactionid', 'tuple')
              AND ${holderPid}::int = ANY (pg_blocking_pids(a.pid))`;
    return rows.map((r) => r.pid);
  }

  /**
   * Resolves with the backends that are waiting for a lock held by the transaction under test
   * (`holderPid`), of the kind given. A wait elsewhere does not count, and it FAILS when no such wait
   * appears: a race test that never reached the race must not pass.
   */
  async function waitUntilBlocked(
    holderPid: number,
    kind: 'advisory' | 'row' = 'row',
    attempts = 100
  ) {
    for (let i = 0; i < attempts; i += 1) {
      const pids = await blockedBehind(holderPid, kind);
      if (pids.length > 0) {
        return pids;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no backend ever waited on a ${kind} lock held by backend ${holderPid}`);
  }

  /**
   * A transaction that holds `hold` until `release()`, then rolls back, on a backend whose pid it
   * reports. `hold` runs inside it.
   */
  async function holding(hold: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let pid = 0;
    const held = prisma
      .$transaction(async (tx) => {
        pid = await backendPid(tx);
        await hold(tx);
        ready();
        await gate;
        throw new Error('rolled back on purpose');
      })
      .catch(() => undefined);
    await isReady;
    return {
      pid,
      rollback: async () => {
        release();
        await held;
      },
    };
  }

  /** An uncommitted open request for the pair: another creation of it waits on its unique index. */
  const holdingOpenRequest = (userId: string, teamId: string) =>
    holding(async (tx) => {
      await tx.teamJoinRequest.create({ data: { teamId, userId } });
    });

  /** The user's row held `FOR UPDATE`: an insert that references the user waits for it. */
  const holdingUserRow = (userId: string) =>
    holding(async (tx) => {
      // CLAUDE.md §7 exception: stands in for a writer of the user row, so an insert that
      // references it waits.
      await tx.$executeRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    });

  /** An organization administrator of orgA who also leads a new team there. */
  async function adminLead(label: string) {
    const teamId = await makeTeam(label, orgA);
    const approver = await makeUser(`adminlead-${label}`);
    await inOrg(approver, orgA, 'ADMIN');
    await onTeam(approver, teamId, 'LEAD');
    const requester = await makeUser(`req-${label}`);
    await inOrg(requester, orgB);
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    return { approver, requester, requestId: created.request.id, teamId };
  }

  it('makes no combined decision when the approver’s organization membership is removed while the approval waits for the locks', async () => {
    const { approver, requestId, requester, teamId } = await adminLead('race-org-admin');
    const removal = await holdingOrgLock(orgA, (tx) =>
      tx.organizationMembership.deleteMany({ where: { orgId: orgA, userId: approver } })
    );
    const pending = approve(approver, teamId, requestId);
    await waitUntilBlocked(removal.pid);
    await removal.commit();
    const done = await pending;
    // Still a team lead, so the team step stands; the organization step is left to someone else.
    expect(done.ok && done.request.status).toBe('PENDING_ORG');
    expect(
      await prisma.organizationMembership.count({ where: { orgId: orgA, userId: requester } })
    ).toBe(0);
    expect(await membershipCount(requester, teamId)).toBe(0);
    const row = await requestRow(requestId);
    expect(row).toMatchObject({ orgDecidedById: null, status: 'PENDING_ORG' });
    const created = await prisma.configAuditLog.findMany({
      where: { actorId: approver, entityType: 'OrganizationMembership' },
    });
    expect(created).toHaveLength(0);
  });

  it('refuses the team step when the approver’s team standing is removed while it waits for the locks', async () => {
    const { approver, requestId, requester, teamId } = await adminLead('race-team-lead');
    // The organization authority goes too, so nothing is left to act through.
    const removal = await holdingOrgLock(orgA, async (tx) => {
      await tx.teamMembership.deleteMany({ where: { teamId, userId: approver } });
      await tx.organizationMembership.deleteMany({ where: { orgId: orgA, userId: approver } });
    });
    const pending = approve(approver, teamId, requestId);
    await waitUntilBlocked(removal.pid);
    await removal.commit();
    expect(await pending).toMatchObject({ code: 'FORBIDDEN', ok: false, status: 403 });
    expect((await requestRow(requestId)).status).toBe('PENDING_TEAM');
    expect(await membershipCount(requester, teamId)).toBe(0);
  });

  it('refuses the organization step when the approver’s organization membership is removed while it waits for the locks', async () => {
    const { requestId, requester, teamId } = await waitingForOrg('race-org-step');
    const approver = await makeUser('org-step-racer');
    await inOrg(approver, orgA, 'ADMIN');
    const removal = await holdingOrgLock(orgA, (tx) =>
      tx.organizationMembership.deleteMany({ where: { orgId: orgA, userId: approver } })
    );
    const pending = orgStep(approver, requestId);
    await waitUntilBlocked(removal.pid);
    await removal.commit();
    expect(await pending).toMatchObject({ code: 'FORBIDDEN', ok: false, status: 403 });
    expect((await requestRow(requestId)).status).toBe('PENDING_ORG');
    expect(await membershipCount(requester, teamId)).toBe(0);
  });

  it('records the held role, unclamped, when the requester joined the team before the organization step', async () => {
    const { leader, requestId, requester, teamId } = await waitingForOrg('joined-meanwhile');
    await onTeam(requester, teamId, 'ADMIN');
    await prisma.user.update({ data: { isActive: false }, where: { id: leader } });
    const done = await orgStep(orgAdmin, requestId);
    expect(done.ok && done.request.grantedRole).toBe('ADMIN');
    expect(
      (
        await prisma.teamMembership.findUniqueOrThrow({
          where: { userId_teamId: { teamId, userId: requester } },
        })
      ).role
    ).toBe('ADMIN');
    expect((await auditsOf(requestId)).at(-1)?.afterJson).toMatchObject({
      clamp: { clamped: false, from: 'ADMIN', to: 'ADMIN' },
    });
  });

  /** Counts the database reads a callback makes through the model delegates the service uses. */
  async function countingQueries<T>(fn: () => Promise<T>): Promise<{ queries: number; value: T }> {
    const delegates = [
      prisma.configSetting,
      prisma.organization,
      prisma.organizationMembership,
      prisma.team,
      prisma.teamJoinRequest,
      prisma.teamMembership,
      prisma.user,
    ] as unknown as Array<Record<string, unknown>>;
    const spies: Array<{ mock: { calls: unknown[] }; mockRestore: () => void }> = delegates.flatMap(
      (delegate) =>
        Object.keys(delegate)
          .filter((method) => typeof delegate[method] === 'function')
          .map((method) => vi.spyOn(delegate as never, method as never) as unknown as never)
    );
    try {
      const value = await fn();
      return { queries: spies.reduce((n, spy) => n + spy.mock.calls.length, 0), value };
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  }

  it('resolves the directory scope of many organizations in a bounded number of queries, as one by one would', async () => {
    const viewer = await makeUser('many-orgs-viewer');
    const ids = Array.from({ length: 1500 }, () => crypto.randomUUID());
    await prisma.organization.createMany({
      data: ids.map((id, i) => ({ id, name: name(`many-${i}`), slug: name(`many-${i}`) })),
    });
    orgIds.push(...ids);
    const stored: Array<[number, unknown]> = [
      [0, 'platform'],
      [1, 'organization'],
      [2, 'organization'],
      [3, 'not a scope'],
      [4, 7],
    ];
    await prisma.configSetting.createMany({
      data: stored.map(([i, value]) => ({
        key: 'teams.directoryScope',
        orgId: ids[i] as string,
        scope: 'ORGANIZATION' as const,
        value: value as never,
      })),
    });
    invalidateSettingsCache();

    const findMany = vi.spyOn(prisma.configSetting, 'findMany');
    const before = _cacheSizeForTests();
    const batch = await resolveSettingForOrganizations('teams.directoryScope', ids);
    const queries = findMany.mock.calls.length;
    const grown = _cacheSizeForTests() - before;
    findMany.mockRestore();
    // The platform value, and one read of the organization rows: not one per organization.
    expect(queries).toBeGreaterThanOrEqual(1);
    expect(queries).toBeLessThanOrEqual(2);
    expect(grown).toBeLessThanOrEqual(2);

    const expected = new Map<string, unknown>();
    for (const id of [ids[0], ids[1], ids[2], ids[3], ids[4], ids[5], ids[1499]] as string[]) {
      expected.set(id, await resolveSetting('teams.directoryScope', { orgId: id }));
    }
    for (const [id, value] of expected) {
      expect(batch.get(id)).toBe(value);
    }
    expect(batch.get(ids[1] as string)).toBe('organization');
    expect(batch.get(ids[3] as string)).toBe('platform'); // an invalid stored value degrades

    // A viewer who belongs to sixty of them, ten of which allow self-service creation: the whole
    // page, creatable organizations included, costs a bounded number of reads however many
    // organizations the viewer is in, and names the ones a per-organization resolve would.
    const memberOf = ids.slice(0, 60);
    await prisma.organizationMembership.createMany({
      data: memberOf.map((orgId) => ({ orgId, role: 'MEMBER' as const, userId: viewer })),
    });
    await prisma.configSetting.createMany({
      data: memberOf.slice(0, 10).map((orgId) => ({
        key: 'teams.selfServiceCreation',
        orgId,
        scope: 'ORGANIZATION' as const,
        value: true,
      })),
    });
    invalidateSettingsCache();
    const cacheBefore = _cacheSizeForTests();
    const { queries: pageQueries, value: listed } = await countingQueries(() =>
      loadDirectory(prisma, { role: 'USER', sub: viewer }, { limit: 10 })
    );
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    expect(pageQueries).toBeLessThanOrEqual(20);
    // A handful of cache entries (each setting's platform value and organization rows), never one
    // per organization.
    expect(_cacheSizeForTests() - cacheBefore).toBeLessThanOrEqual(8);
    expect(listed.creatableOrgs.map((o) => o.id).sort()).toEqual(memberOf.slice(0, 10).sort());
  }, 60_000);

  /** The platform-wide `teams.directoryScope` (a GLOBAL row, which belongs to no tenant); `undefined` removes it. */
  const setGlobalDirectoryScope = (value: unknown) =>
    runUnscoped('test: the platform-wide directory scope', ['ConfigSetting'], async () => {
      await prisma.configSetting.deleteMany({
        where: { key: 'teams.directoryScope', scope: 'GLOBAL' },
      });
      if (value !== undefined) {
        await prisma.configSetting.create({
          data: { key: 'teams.directoryScope', scope: 'GLOBAL', value: value as never },
        });
      }
    });

  it('shows exactly the teams a per-organization resolve allows, for random overrides, memberships and platform values', async () => {
    let seed = 20_261_121;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)] as T;
    const prefix = name('dv-');
    const orgs: string[] = [];
    const allTeams: Array<{ id: string; orgId: string }> = [];
    for (let i = 0; i < 24; i += 1) {
      const org = await prisma.organization.create({
        data: { isActive: rnd() > 0.2, name: `${prefix}o${i}`, slug: `${prefix}o${i}` },
      });
      orgIds.push(org.id);
      orgs.push(org.id);
      // Valid values, and every shape of invalid one: wrong case, wrong type, array, object.
      const override = pick<unknown>([
        undefined,
        undefined,
        'platform',
        'organization',
        'organization',
        'bogus',
        7,
        ['platform'],
        { v: 'platform' },
        'PLATFORM',
      ]);
      if (override !== undefined) {
        await prisma.configSetting.create({
          data: {
            key: 'teams.directoryScope',
            orgId: org.id,
            scope: 'ORGANIZATION',
            value: override as never,
          },
        });
      }
      for (let j = 0; j < 1 + Math.floor(rnd() * 3); j += 1) {
        const team = await prisma.team.create({
          data: {
            isActive: rnd() > 0.2,
            name: `${prefix}t${i}-${j}`,
            orgId: org.id,
            slug: `${prefix}t${i}-${j}`,
          },
        });
        teamIds.push(team.id);
        allTeams.push({ id: team.id, orgId: org.id });
      }
    }
    // A row of another scope under the same key must change nothing.
    await prisma.configSetting.create({
      data: {
        key: 'teams.directoryScope',
        scope: 'TEAM',
        teamId: allTeams[0]?.id,
        value: 'organization',
      },
    });
    const viewers: Array<{ id: string; orgs: Set<string> }> = [];
    for (let v = 0; v < 4; v += 1) {
      const id = await makeUser(`dv-viewer-${v}`);
      const mine = new Set<string>();
      for (const orgId of orgs) {
        if (v > 0 && rnd() < 0.25) {
          mine.add(orgId);
          await inOrg(id, orgId);
        }
      }
      viewers.push({ id, orgs: mine });
    }
    const allPages = async (viewer: string, orgId?: string) => {
      const ids: string[] = [];
      let cursor: string | undefined;
      let organizations: string[] = [];
      for (let page = 0; page < 100; page += 1) {
        const dir = await loadDirectory(
          prisma,
          { role: 'USER', sub: viewer },
          { cursor, limit: 7, orgId, q: prefix }
        );
        if (!dir.ok) {
          throw new Error('the directory refused');
        }
        ids.push(...dir.teams.map((t) => t.id));
        organizations = dir.organizations.map((o) => o.id);
        if (!dir.nextCursor) {
          break;
        }
        cursor = dir.nextCursor;
      }
      return { ids, organizations };
    };
    const failures: string[] = [];
    try {
      for (const global of [undefined, 'platform', 'organization', 'bogus']) {
        await setGlobalDirectoryScope(global);
        invalidateSettingsCache();
        const live = new Map(
          (
            await runUnscoped('test: team activity', ['Team'], () =>
              prisma.team.findMany({
                select: { id: true, isActive: true, organization: { select: { isActive: true } } },
                where: { id: { in: allTeams.map((t) => t.id) } },
              })
            )
          ).map((t) => [t.id, t.isActive && t.organization.isActive])
        );
        const scopeOf = new Map<string, unknown>();
        for (const orgId of orgs) {
          scopeOf.set(orgId, await resolveSetting('teams.directoryScope', { orgId }));
        }
        const allowedFor = (viewer: { orgs: Set<string> }, team: { id: string; orgId: string }) =>
          Boolean(
            live.get(team.id) &&
              (viewer.orgs.has(team.orgId) || scopeOf.get(team.orgId) === 'platform')
          );
        for (const viewer of viewers) {
          const expected = allTeams.filter((t) => allowedFor(viewer, t));
          const { ids, organizations } = await allPages(viewer.id);
          const label = `global=${String(global)} viewer=${viewer.id}`;
          expect([...ids].sort(), label).toEqual(expected.map((t) => t.id).sort());
          expect(organizations.filter((id) => orgs.includes(id)).sort(), label).toEqual(
            [...new Set(expected.map((t) => t.orgId))].sort()
          );
          for (const orgId of orgs.slice(0, 8)) {
            const one = await allPages(viewer.id, orgId);
            expect([...one.ids].sort(), `${label} org=${orgId}`).toEqual(
              expected
                .filter((t) => t.orgId === orgId)
                .map((t) => t.id)
                .sort()
            );
          }
        }
        for (const viewer of viewers.slice(0, 2)) {
          for (const team of allTeams) {
            const result = await create(viewer.id, team.id);
            if (result.ok !== allowedFor(viewer, team)) {
              failures.push(`create global=${String(global)} team=${team.id}`);
            }
            await runUnscoped('test: reset the cooldown', ['TeamJoinRequest'], () =>
              prisma.teamJoinRequest.deleteMany({ where: { userId: viewer.id } })
            );
          }
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await setGlobalDirectoryScope(undefined);
      invalidateSettingsCache();
      // Leave nothing the other directory tests would list: they assert exactly which organizations
      // and teams a viewer sees.
      await runUnscoped(
        'test fixture: the random organizations',
        ['Team', 'TeamJoinRequest', 'TeamMembership', 'OrganizationMembership'],
        async () => {
          const where = { orgId: { in: orgs } };
          await prisma.teamJoinRequest.deleteMany({ where: { team: where } });
          await prisma.teamMembership.deleteMany({ where: { team: where } });
          await prisma.team.deleteMany({ where });
          await prisma.organizationMembership.deleteMany({ where });
        }
      );
      await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    }
  }, 300_000);

  /**
   * Fresh planner statistics after a bulk load. The tests below insert tens of thousands of rows
   * and delete them again within seconds, far faster than autovacuum's analyze, and a plan chosen
   * from stale statistics for "a few rows" can turn a correlated lookup into a table scan per row.
   */
  const analyzeTables = async () => {
    // CLAUDE.md §7 exception: refreshes the server's planner statistics, not application data.
    await prisma.$executeRaw`ANALYZE organizations, teams, config_settings`;
  };

  /* ── Follow-up: the directory at scale ─────────────────────────────────── */

  it('lists the directory for tens of thousands of organizations in a bounded number of queries, by the per-organization rule', async () => {
    const BULK = 40_000;
    const bulkPrefix = name('bulk-');
    // The platform value is a GLOBAL row, which belongs to no tenant.
    const setPlatformValue = (value: 'organization' | null) =>
      runUnscoped('test: the platform-wide directory scope', ['ConfigSetting'], async () => {
        await prisma.configSetting.deleteMany({
          where: { key: 'teams.directoryScope', scope: 'GLOBAL' },
        });
        if (value) {
          await prisma.configSetting.create({
            data: { key: 'teams.directoryScope', scope: 'GLOBAL', value },
          });
        }
      });
    try {
      for (let from = 0; from < BULK; from += 5000) {
        await prisma.organization.createMany({
          data: Array.from({ length: 5000 }, (_, i) => ({
            name: `${bulkPrefix}${from + i}`,
            slug: `${bulkPrefix}${from + i}`,
          })),
        });
      }
      await analyzeTables();
      // More organizations with a team than the filter lists.
      const withTeams = await prisma.organization.findMany({
        orderBy: { name: 'asc' },
        select: { id: true },
        take: DIRECTORY_ORGANIZATIONS_LIMIT + 20,
        where: { name: { startsWith: bulkPrefix } },
      });
      orgIds.push(...withTeams.map((o) => o.id));
      await prisma.team.createMany({
        data: withTeams.map((o, i) => ({
          name: name(`bulkteam-${i}`),
          orgId: o.id,
          slug: name(`bulkteam-${i}`),
        })),
      });
      teamIds.push(
        ...(
          await prisma.team.findMany({
            select: { id: true },
            where: { orgId: { in: withTeams.map((o) => o.id) } },
          })
        ).map((t) => t.id)
      );

      const viewer = await makeUser('big-viewer');
      const sample = {
        dead: await makeOrg('big-dead'), // inactive, a platform-scope team inside it
        hidden: await makeOrg('big-hidden'), // chose `organization`; the viewer is outside
        invalid: await makeOrg('big-invalid'), // a stored value the schema rejects
        member: await makeOrg('big-member'), // chose `organization`; the viewer is inside
        open: await makeOrg('big-open'), // chose `platform`
        plain: await makeOrg('big-plain'), // no override
      };
      await prisma.organization.update({ data: { isActive: false }, where: { id: sample.dead } });
      await inOrg(viewer, sample.member);
      const stored: Array<[string, unknown]> = [
        [sample.hidden, 'organization'],
        [sample.invalid, 'nonsense'],
        [sample.member, 'organization'],
        [sample.open, 'platform'],
      ];
      await prisma.configSetting.createMany({
        data: stored.map(([orgId, value]) => ({
          key: 'teams.directoryScope',
          orgId,
          scope: 'ORGANIZATION' as const,
          value: value as never,
        })),
      });
      const teamOf: Record<string, string> = {};
      for (const [label, orgId] of Object.entries(sample)) {
        teamOf[label] = await makeTeam(`vis-${label}`, orgId);
      }

      for (const platformValue of ['platform', 'organization'] as const) {
        await setPlatformValue(platformValue === 'organization' ? 'organization' : null);
        invalidateSettingsCache();

        // The oracle: the rule written out per organization, with the per-organization resolver.
        const expectedVisible: string[] = [];
        for (const [label, orgId] of Object.entries(sample)) {
          const scope = await resolveSetting('teams.directoryScope', { orgId });
          const isMember = orgId === sample.member;
          if (label !== 'dead' && (isMember || scope === 'platform')) {
            expectedVisible.push(teamOf[label] as string);
          }
        }
        invalidateSettingsCache();

        const { queries, value: dir } = await countingQueries(() =>
          loadDirectory(prisma, { role: 'USER', sub: viewer }, { limit: 100, q: name('team-vis-') })
        );
        expect(dir.ok).toBe(true);
        if (!dir.ok) {
          return;
        }
        expect(dir.scope).toBe(platformValue);
        expect(dir.teams.map((t) => t.id).sort(), platformValue).toEqual(expectedVisible.sort());
        expect(queries).toBeLessThanOrEqual(20);

        // The filter of organizations is capped, and agrees with the rule where it is not cut.
        expect(dir.organizations.length).toBeLessThanOrEqual(DIRECTORY_ORGANIZATIONS_LIMIT);
        if (platformValue === 'platform') {
          expect(dir.organizations).toHaveLength(DIRECTORY_ORGANIZATIONS_LIMIT);
          expect(dir.organizationsTruncated).toBe(true);
        } else {
          expect(dir.organizationsTruncated).toBe(false);
          const listedOrgs = dir.organizations.map((o) => o.id).sort();
          const wanted = [sample.member, sample.open].sort();
          // Every bulk organization chose nothing, so under `organization` only these two list.
          expect(listedOrgs).toEqual(wanted);
        }
        // `orgId` narrows the page the same way, and a hidden organization yields nothing.
        const hidden = await loadDirectory(
          prisma,
          { role: 'USER', sub: viewer },
          { limit: 10, orgId: sample.hidden }
        );
        expect(hidden.ok && hidden.teams).toHaveLength(0);

        // Creating a request answers by the same rule.
        for (const [label, teamId] of Object.entries(teamOf)) {
          const result = await create(viewer, teamId);
          const allowed = expectedVisible.includes(teamId);
          expect(result.ok, `${platformValue}/${label}`).toBe(allowed);
          if (!allowed) {
            expect(result).toMatchObject({ code: 'TEAM_NOT_FOUND', status: 404 });
          } else if (result.ok) {
            await withdrawRequest(fastify, {
              actor: actorOf(viewer),
              context: ctx,
              requestId: result.request.id,
            });
          }
        }
        // Withdrawing starts a cooldown the next round must not meet.
        await runUnscoped('test: reset the cooldown', ['TeamJoinRequest'], () =>
          prisma.teamJoinRequest.deleteMany({ where: { userId: viewer } })
        );
      }
    } finally {
      await setPlatformValue(null);
      invalidateSettingsCache();
      await runUnscoped(
        'test fixture: bulk organizations',
        ['Team', 'TeamJoinRequest'],
        async () => {
          await prisma.teamJoinRequest.deleteMany({
            where: { team: { organization: { name: { startsWith: bulkPrefix } } } },
          });
          await prisma.team.deleteMany({
            where: { organization: { name: { startsWith: bulkPrefix } } },
          });
        }
      );
      await prisma.organization.deleteMany({ where: { name: { startsWith: bulkPrefix } } });
    }
  }, 180_000);

  it('does not send the organization overrides as query parameters: the directory and a create work with 40,000 of them under either platform value', async () => {
    const BULK = 40_000;
    const bulkPrefix = name('ovr-');
    const started = Date.now();
    try {
      for (let from = 0; from < BULK; from += 5000) {
        const ids = Array.from({ length: 5000 }, () => crypto.randomUUID());
        await prisma.organization.createMany({
          data: ids.map((id, i) => ({
            id,
            name: `${bulkPrefix}${from + i}`,
            slug: `${bulkPrefix}${from + i}`,
          })),
        });
        // Under the `platform` value these are 40,000 organizations that chose `organization`.
        await prisma.configSetting.createMany({
          data: ids.map((orgId) => ({
            key: 'teams.directoryScope',
            orgId,
            scope: 'ORGANIZATION' as const,
            value: 'organization',
          })),
        });
      }
      await analyzeTables();
      const viewer = await makeUser('ovr-viewer');
      const sample = {
        dead: await makeOrg('ovr-dead'),
        hidden: await makeOrg('ovr-hidden'),
        invalid: await makeOrg('ovr-invalid'),
        member: await makeOrg('ovr-member'),
        open: await makeOrg('ovr-open'),
        plain: await makeOrg('ovr-plain'),
      };
      await prisma.organization.update({ data: { isActive: false }, where: { id: sample.dead } });
      await inOrg(viewer, sample.member);
      await prisma.configSetting.createMany({
        data: (
          [
            [sample.hidden, 'organization'],
            [sample.invalid, 'nonsense'],
            [sample.member, 'organization'],
            [sample.open, 'platform'],
          ] as const
        ).map(([orgId, value]) => ({
          key: 'teams.directoryScope',
          orgId,
          scope: 'ORGANIZATION' as const,
          value,
        })),
      });
      const teamOf: Record<string, string> = {};
      for (const [label, orgId] of Object.entries(sample)) {
        teamOf[label] = await makeTeam(`ovr-${label}`, orgId);
      }

      for (const platformValue of ['platform', 'organization'] as const) {
        if (platformValue === 'organization') {
          // The same 40,000 organizations now chose `platform`: the long list is the other side.
          await runUnscoped('test: flip the bulk overrides', ['ConfigSetting'], () =>
            prisma.configSetting.updateMany({
              data: { value: 'platform' },
              where: {
                key: 'teams.directoryScope',
                organization: { name: { startsWith: bulkPrefix } },
                scope: 'ORGANIZATION',
              },
            })
          );
        }
        await setGlobalDirectoryScope(
          platformValue === 'organization' ? 'organization' : undefined
        );
        invalidateSettingsCache();

        const expectedVisible: string[] = [];
        for (const [label, orgId] of Object.entries(sample)) {
          const scope = await resolveSetting('teams.directoryScope', { orgId });
          if (label !== 'dead' && (orgId === sample.member || scope === 'platform')) {
            expectedVisible.push(teamOf[label] as string);
          }
        }
        invalidateSettingsCache();

        const dir = await loadDirectory(
          prisma,
          { role: 'USER', sub: viewer },
          { limit: 100, q: name('team-ovr-') }
        );
        expect(dir.ok, platformValue).toBe(true);
        if (!dir.ok) {
          return;
        }
        expect(dir.scope).toBe(platformValue);
        expect(dir.teams.map((t) => t.id).sort(), platformValue).toEqual(expectedVisible.sort());

        for (const [label, teamId] of Object.entries(teamOf)) {
          const result = await create(viewer, teamId);
          const allowed = expectedVisible.includes(teamId);
          expect(result.ok, `${platformValue}/${label}`).toBe(allowed);
          if (result.ok) {
            await withdrawRequest(fastify, {
              actor: actorOf(viewer),
              context: ctx,
              requestId: result.request.id,
            });
          } else {
            expect(result).toMatchObject({ code: 'TEAM_NOT_FOUND', status: 404 });
          }
        }
        await runUnscoped('test: reset the cooldown', ['TeamJoinRequest'], () =>
          prisma.teamJoinRequest.deleteMany({ where: { userId: viewer } })
        );
      }
      console.info(`40,000 organization overrides: ${Date.now() - started} ms`);
    } finally {
      await setGlobalDirectoryScope(undefined);
      invalidateSettingsCache();
      await prisma.organization.deleteMany({ where: { name: { startsWith: bulkPrefix } } });
    }
  }, 300_000);

  it('does not deadlock a deactivation that also changes a unique column with an approval in flight', async () => {
    const { requester, teamId } = await scenario('deadlock');
    const created = await create(requester, teamId);
    if (!created.ok) {
      throw new Error('setup failed');
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed!: () => void;
    const hasClaimed = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    // The approval's order: the request row is claimed first, the membership written after.
    let approvalPid = 0;
    const approval = prisma.$transaction(async (tx) => {
      approvalPid = await backendPid(tx);
      await tx.teamJoinRequest.updateMany({
        data: { status: 'APPROVED' },
        where: { id: created.request.id, status: 'PENDING_TEAM', teamId },
      });
      claimed();
      await gate;
      await tx.teamMembership.create({ data: { role: 'MEMBER', teamId, userId: requester } });
    });
    await hasClaimed;
    // Changing the email takes the user row's strongest lock, the one a membership insert waits on.
    const patch = app.inject({
      headers: actAs(platformAdmin),
      method: 'PATCH',
      payload: { email: `${name('deadlock-new')}@example.test`, isActive: false },
      url: `/api/v1/users/${requester}`,
    });
    await waitUntilBlocked(approvalPid);
    release();
    const [done, response] = await Promise.all([
      approval.then(
        () => 'ok',
        (e: unknown) => e
      ),
      patch,
    ]);
    expect(done, String(done)).toBe('ok');
    expect(response.statusCode, response.body).toBe(200);
    expect(await membershipCount(requester, teamId)).toBe(1);
    expect((await requestRow(created.request.id)).status).toBe('APPROVED');
  }, 30_000);
  /* ── Review fixes: creation against a deactivation ─────────────────────── */

  const openCountOf = (userId: string) =>
    runUnscoped('test: count open requests', ['TeamJoinRequest'], () =>
      prisma.teamJoinRequest.count({
        where: { status: { in: ['PENDING_TEAM', 'PENDING_ORG'] }, userId },
      })
    );

  /** `createJoinRequest` on an app whose first transaction runs `before` first. */
  const createAfter = (userId: string, teamId: string, before: () => Promise<unknown>) => {
    let first = true;
    const hooked = new Proxy(prisma, {
      get(target, key, receiver) {
        if (key === '$transaction') {
          return async (...args: unknown[]) => {
            if (first) {
              first = false;
              await before();
            }
            return (target.$transaction as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    return createJoinRequest({ prisma: hooked } as unknown as FastifyInstance, {
      actor: actorOf(userId),
      context: ctx,
      message: 'hi',
      teamId,
    });
  };

  const settled = (promise: Promise<unknown>) => {
    const state = { done: false };
    void promise.then(
      () => {
        state.done = true;
      },
      () => {
        state.done = true;
      }
    );
    return state;
  };

  /** Waits until `other` has finished, or a backend waits for a lock `holderPid` holds. */
  async function untilSettledOrBlocked(
    other: { done: boolean },
    holderPid: number,
    kind: 'advisory' | 'row'
  ) {
    for (let i = 0; i < 100; i += 1) {
      if (other.done || (await blockedBehind(holderPid, kind)).length > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the competing transaction neither finished nor waited');
  }

  const deactivate = (userId: string) =>
    app.inject({
      headers: actAs(platformAdmin),
      method: 'PATCH',
      payload: { isActive: false },
      url: `/api/v1/users/${userId}`,
    });

  it('fails to wait for a lock when the only waits are on other transactions or of another kind', async () => {
    const unrelated = await holdingUserRow(await makeUser('wait-unrelated'));
    const held = await holdingUserRow(await makeUser('wait-held'));
    const row = await makeUser('wait-row');
    const holderOfRow = await holdingUserRow(row);
    // A backend waits on `holderOfRow`, so a wait elsewhere is not the one under test, and an
    // advisory wait is not a row wait.
    const waiter = holding(async (tx) => {
      // CLAUDE.md §7 exception: waits on the row `holderOfRow` holds.
      await tx.$executeRaw`SELECT 1 FROM users WHERE id = ${row}::uuid FOR UPDATE`;
    });
    try {
      await waitUntilBlocked(holderOfRow.pid);
      await expect(waitUntilBlocked(unrelated.pid, 'row', 5)).rejects.toThrow(
        /no backend ever waited/
      );
      await expect(waitUntilBlocked(held.pid, 'row', 5)).rejects.toThrow(/no backend ever waited/);
      await expect(waitUntilBlocked(holderOfRow.pid, 'advisory', 5)).rejects.toThrow(
        /no backend ever waited/
      );
    } finally {
      await holderOfRow.rollback();
      await waiter.then((w) => w.rollback());
      await unrelated.rollback();
      await held.rollback();
    }
  });

  it('refuses a request when the requester was deactivated after the checks and before the transaction', async () => {
    const { requester, teamId } = await scenario('create-then-deactivated');
    const result = await createAfter(requester, teamId, () => deactivate(requester));
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(await openCountOf(requester)).toBe(0);
  });

  it('refuses a request, as for an unknown team, when the team was deactivated after the checks and before the transaction', async () => {
    const { requester, teamId } = await scenario('create-then-team-deleted');
    const result = await createAfter(requester, teamId, async () => {
      const res = await app.inject({
        headers: actAs(platformAdmin),
        method: 'DELETE',
        url: `/api/v1/teams/${teamId}`,
      });
      expect(res.statusCode).toBe(200);
    });
    expect(result).toMatchObject({ code: 'TEAM_NOT_FOUND', ok: false, status: 404 });
    expect(await openCountOf(requester)).toBe(0);
  });

  it('closes a request created while its requester is being deactivated, or never creates it', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { requester, teamId } = await scenario(`create-race-user-${i}`);
      // Another creation of the same request is mid-flight, so this one stops at its insert, after
      // it has read the account as active.
      const other = await holdingOpenRequest(requester, teamId);
      const creating = create(requester, teamId);
      const [creatingPid] = await waitUntilBlocked(other.pid, 'row');
      const deactivating = deactivate(requester);
      // The deactivation either finishes first (nothing to close, the creation then lands open: the
      // bug) or waits for the creation's per-person lock.
      await untilSettledOrBlocked(settled(deactivating), creatingPid as number, 'advisory');
      await other.rollback();
      const [made, response] = await Promise.all([creating, deactivating]);
      expect(response.statusCode, response.body).toBe(200);
      expect(await openCountOf(requester), `iteration ${i}`).toBe(0);
      if (made.ok) {
        expect(await requestRow(made.request.id)).toMatchObject({
          closeReason: 'REQUESTER_DEACTIVATED',
          status: 'WITHDRAWN',
        });
      } else {
        expect(made).toMatchObject({ status: 401 });
      }
    }
  }, 60_000);

  it('refuses a request that waits on a team whose deletion commits first', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { requester, teamId } = await scenario(`create-behind-delete-${i}`);
      // The deletion's own steps, held open before they commit: the row lock, the deactivation and
      // the closing of the requests that exist so far.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const isReady = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let pid = 0;
      const deleting = prisma.$transaction(async (tx) => {
        pid = await backendPid(tx);
        // CLAUDE.md §7 exception: the team deletion's row lock.
        await tx.$executeRaw`SELECT 1 FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
        await tx.team.update({ data: { isActive: false }, where: { id: teamId } });
        await closeOpenJoinRequests(fastify, tx, {
          actor: actorOf(platformAdmin),
          scope: { reason: 'TEAM_DEACTIVATED', teamId },
        });
        ready();
        await gate;
      });
      await isReady;
      const creating = create(requester, teamId);
      await waitUntilBlocked(pid, 'row');
      release();
      await deleting;
      // Past the deletion, the team is inactive: the answer is the one an unknown team gets, and
      // nothing is left open for a team nobody can decide in.
      expect(await creating, `iteration ${i}`).toMatchObject({
        code: 'TEAM_NOT_FOUND',
        ok: false,
        status: 404,
      });
      expect(await openCountOf(requester)).toBe(0);
    }
  }, 60_000);

  it('closes a request created while its team is being deleted, or never creates it', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { requester, teamId } = await scenario(`create-race-team-${i}`);
      // The requester's row is held, so the creation stops at its insert, after it has re-read the
      // team as active and taken the share lock on it.
      const writer = await holdingUserRow(requester);
      const creating = create(requester, teamId);
      const [creatingPid] = await waitUntilBlocked(writer.pid, 'row');
      const deleting = app.inject({
        headers: actAs(platformAdmin),
        method: 'DELETE',
        url: `/api/v1/teams/${teamId}`,
      });
      // The deletion either finishes first (nothing to close; the creation lands open: the bug) or
      // waits for the creation's share lock on the team row.
      await untilSettledOrBlocked(settled(deleting), creatingPid as number, 'row');
      await writer.rollback();
      const [made, response] = await Promise.all([creating, deleting]);
      expect(response.statusCode, response.body).toBe(200);
      expect(await openCountOf(requester), `iteration ${i}`).toBe(0);
      if (made.ok) {
        expect(await requestRow(made.request.id)).toMatchObject({
          closeReason: 'TEAM_DEACTIVATED',
          status: 'REJECTED',
        });
      } else {
        expect(made).toMatchObject({ code: 'TEAM_NOT_FOUND', status: 404 });
      }
    }
  }, 60_000);

  /* ── Review fixes: the team step audits the authority it decided under ─── */

  /** The route's earlier check said `team-role`; whatever is audited must come from the locks. */
  const approveAsTeamRole = (reviewer: string, teamId: string, requestId: string) =>
    approveAtTeamStep(fastify, {
      actor: actorOf(reviewer),
      context: { authority: 'team-role' },
      requestId,
      teamId,
    });

  it('audits the organization authority when the approver’s team role is removed while the approval waits', async () => {
    const { approver, requestId, requester, teamId } = await adminLead('audit-authority');
    const removal = await holdingOrgLock(orgA, (tx) =>
      tx.teamMembership.deleteMany({ where: { teamId, userId: approver } })
    );
    const pending = approveAsTeamRole(approver, teamId, requestId);
    await waitUntilBlocked(removal.pid);
    await removal.commit();
    const done = await pending;
    // Still an organization administrator: the team step stands, as one decision with both steps.
    expect(done.ok && done.request.status).toBe('APPROVED');
    expect(await membershipCount(requester, teamId)).toBe(1);
    const rows = await auditsOf(requestId);
    const update = rows.at(-1);
    expect(update?.context).toMatchObject({ authority: 'org-admin' });
    expect(update?.afterJson).toMatchObject({
      combinedDecision: { authority: { organization: 'org-admin', team: 'org-admin' } },
    });
    const membership = await prisma.configAuditLog.findMany({
      where: { actorId: approver, entityType: 'TeamMembership' },
    });
    expect(membership).toHaveLength(1);
    expect(membership[0]?.context).toMatchObject({ authority: 'org-admin' });
    expect(JSON.stringify(rows.map((r) => r.context))).not.toContain('team-role');
  });

  it('refuses a team approval whose approver was deactivated while it waited for the locks', async () => {
    const { approver, requestId, requester, teamId } = await adminLead('approver-deactivated');
    const removal = await holdingOrgLock(orgA, (tx) =>
      tx.user.update({ data: { isActive: false }, where: { id: approver } })
    );
    const pending = approveAsTeamRole(approver, teamId, requestId);
    await waitUntilBlocked(removal.pid);
    await removal.commit();
    expect(await pending).toMatchObject({ ok: false, status: 401 });
    expect((await requestRow(requestId)).status).toBe('PENDING_TEAM');
    expect(await membershipCount(requester, teamId)).toBe(0);
  });

  /* ── Review fixes: the organization step decides under the locks, too ─── */

  /** An organization administrator of orgA of their own, so deactivating them touches no other test. */
  async function freshOrgAdmin(label: string) {
    const id = await makeUser(`orgadmin-${label}`);
    await inOrg(id, orgA, 'ADMIN');
    return id;
  }

  it('refuses an organization approval whose approver was deactivated while it waited for the locks', async () => {
    const { requestId, requester, teamId } = await waitingForOrg('org-approver-deactivated');
    const approver = await freshOrgAdmin('deactivated');
    const removal = await holdingOrgLock(orgA, (tx) =>
      tx.user.update({ data: { isActive: false }, where: { id: approver } })
    );
    const pending = orgStep(approver, requestId);
    await waitUntilBlocked(removal.pid);
    await removal.commit();
    expect(await pending).toMatchObject({ code: 'TOKEN_INVALID', ok: false, status: 401 });
    expect((await requestRow(requestId)).status).toBe('PENDING_ORG');
    expect(await membershipCount(requester, teamId)).toBe(0);
  });

  it('audits the organization authority read under the locks, not the route’s earlier check', async () => {
    const { requestId, requester, teamId } = await waitingForOrg('org-audit-authority');
    const approver = await freshOrgAdmin('audit');
    const done = await approveAtOrgStep(fastify, {
      actor: actorOf(approver),
      // What the route saw before it waited for the locks; the audit must not repeat it.
      context: { authority: 'team-role' },
      orgId: orgA,
      requestId,
    });
    expect(done.ok && done.request.status).toBe('APPROVED');
    expect(await membershipCount(requester, teamId)).toBe(1);
    const update = (await auditsOf(requestId)).at(-1);
    expect(update?.context).toMatchObject({ authority: 'org-admin' });
    const writes = await prisma.configAuditLog.findMany({
      where: {
        actorId: approver,
        entityType: { in: ['OrganizationMembership', 'TeamMembership'] },
      },
    });
    expect(writes.map((w) => w.entityType).sort()).toEqual([
      'OrganizationMembership',
      'TeamMembership',
    ]);
    for (const write of writes) {
      expect(write.context).toMatchObject({ authority: 'org-admin' });
    }
    expect(JSON.stringify([update, ...writes].map((r) => r?.context))).not.toContain('team-role');
  });

  /* ── Review fixes: one lock key per person, whatever the case of the id ── */

  it('takes the per-person lock under the canonical id when a deactivation names the user in upper case', async () => {
    const { requester, teamId } = await scenario('upper-case-id');
    // A creation inside its transaction: it holds the person's lock and has inserted its request.
    const creating = await holding(async (tx) => {
      // CLAUDE.md §7 exception: stands in for the creation's per-person advisory lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`join-request:${requester}`}, 0))`;
      await tx.teamJoinRequest.create({ data: { message: 'x', teamId, userId: requester } });
    });
    const patch = app.inject({
      headers: actAs(platformAdmin),
      method: 'PATCH',
      payload: { isActive: false },
      url: `/api/v1/users/${requester.toUpperCase()}`,
    });
    // It must wait for that lock rather than slip past it on a differently spelled key.
    await waitUntilBlocked(creating.pid, 'advisory');
    await creating.rollback();
    expect((await patch).statusCode).toBe(200);
    expect(await openCountOf(requester)).toBe(0);
  }, 30_000);
});
