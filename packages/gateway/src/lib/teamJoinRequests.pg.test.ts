import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JwtPayload } from '../plugins/auth.js';
import {
  approveAtOrgStep,
  approveAtTeamStep,
  createJoinRequest,
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

  beforeAll(async () => {
    orgA = await makeOrg('a');
    orgB = await makeOrg('b');
    lead = await makeUser('lead');
    admin = await makeUser('admin');
    orgAdmin = await makeUser('org-admin');
    await inOrg(lead, orgA);
    await inOrg(admin, orgA);
    await inOrg(orgAdmin, orgA, 'ADMIN');
  });

  afterAll(async () => {
    await runUnscoped(
      'test fixture: throwaway database',
      ['OrganizationMembership', 'Team', 'TeamJoinRequest', 'TeamMembership'],
      async () => {
        await prisma.teamJoinRequest.deleteMany({ where: { teamId: { in: teamIds } } });
        await prisma.teamMembership.deleteMany({ where: { teamId: { in: teamIds } } });
        await prisma.team.deleteMany({ where: { orgId: { in: orgIds } } });
        await prisma.organizationMembership.deleteMany({ where: { orgId: { in: orgIds } } });
      }
    );
    await prisma.configAuditLog.deleteMany({
      where: { actorId: { in: userIds } },
    });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
});
