import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICE_LAUNCH_REFUSALS, servicePrincipalLaunchGuard } from './servicePrincipals.js';
import { launchTrackedWorkflow } from './workflowLaunch.js';

/**
 * Service principals against real Postgres: the hand-written `api_tokens_exactly_one_owner`
 * CHECK, the principal → tokens cascade, and the launch guard's row lock serializing two
 * concurrent launches against `maxInFlight = 1`. A mocked Prisma can show none of these.
 *
 * Opt in with `SERVICE_PRINCIPAL_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy`
 * has been run against (it writes and deletes rows, so use a throwaway one):
 *
 *   SERVICE_PRINCIPAL_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/gateway/src/lib/servicePrincipals.pg.test.ts
 */
const enabled = process.env.SERVICE_PRINCIPAL_PG_TEST === '1';

describe.skipIf(!enabled)('service principals against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  let userId: string;
  let orgId: string;
  let teamId: string;
  let repoId: string;
  let principalId: string;

  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped('test fixture: throwaway database', ['Team', 'Connection', 'ServicePrincipal'], fn);

  const tokenData = () => {
    const token = `ats_${crypto.randomBytes(16).toString('hex')}`;
    return { name: 't', prefix: token.slice(0, 12), tokenHash: crypto.hash('sha256', token) };
  };

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `sp-${suffix}@example.test`, emailVerified: true, name: 'sp' },
    });
    userId = user.id;
    await unscoped(async () => {
      const org = await prisma.organization.create({
        data: { name: `sp-org-${suffix}`, slug: `sp-org-${suffix}` },
      });
      orgId = org.id;
      const team = await prisma.team.create({
        data: { name: `sp-team-${suffix}`, orgId, slug: `sp-team-${suffix}` },
      });
      teamId = team.id;
      const repo = await prisma.connection.create({
        data: { organizationName: `sp-${suffix}`, repoName: 'repo', teamId, type: 'git_repo' },
      });
      repoId = repo.id;
      const sp = await prisma.servicePrincipal.create({
        data: {
          connectionIds: [repoId],
          createdById: userId,
          maxInFlight: 1,
          maxRunsPerDay: 10,
          name: `deployer-${suffix}`,
          teamId,
        },
      });
      principalId = sp.id;
    });
  });

  afterAll(async () => {
    await prisma.activeWorkflow.deleteMany({ where: { repoId } });
    await prisma.runInput.deleteMany({ where: { connectionId: repoId } });
    await prisma.apiToken.deleteMany({
      where: { OR: [{ userId }, { servicePrincipalId: principalId }] },
    });
    await unscoped(async () => {
      await prisma.servicePrincipal.deleteMany({ where: { teamId } });
      await prisma.connection.deleteMany({ where: { id: repoId } });
      await prisma.team.deleteMany({ where: { id: teamId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  describe('api_tokens_exactly_one_owner', () => {
    it('refuses a token with no owner', async () => {
      await expect(prisma.apiToken.create({ data: tokenData() })).rejects.toThrow(
        /api_tokens_exactly_one_owner|check constraint/i
      );
    });

    it('refuses a token with both owners', async () => {
      await expect(
        prisma.apiToken.create({
          data: { ...tokenData(), servicePrincipalId: principalId, userId },
        })
      ).rejects.toThrow(/api_tokens_exactly_one_owner|check constraint/i);
    });

    it('accepts either owner alone, and defaults scopes to the empty list', async () => {
      const personal = await prisma.apiToken.create({ data: { ...tokenData(), userId } });
      expect(personal.scopes).toEqual([]);
      const service = await prisma.apiToken.create({
        data: {
          ...tokenData(),
          expiresAt: new Date(Date.now() + 86_400_000),
          scopes: ['runs:read'],
          servicePrincipalId: principalId,
        },
      });
      expect(service.userId).toBeNull();
    });
  });

  it("deletes a principal's tokens with it", async () => {
    const sp = await unscoped(() =>
      prisma.servicePrincipal.create({ data: { name: `doomed-${suffix}`, teamId } })
    );
    await prisma.apiToken.create({
      data: {
        ...tokenData(),
        expiresAt: new Date(Date.now() + 86_400_000),
        servicePrincipalId: sp.id,
      },
    });
    await prisma.servicePrincipal.delete({ where: { id: sp.id } });
    expect(await prisma.apiToken.count({ where: { servicePrincipalId: sp.id } })).toBe(0);
  });

  it('admits exactly one of two concurrent launches at maxInFlight = 1', async () => {
    const launch = () => {
      const workRequestId = crypto.randomUUID();
      return launchTrackedWorkflow(
        prisma as never,
        {
          activeWorkflow: {
            budgetTier: 'STANDARD',
            currentStatus: 'IMPLEMENTING',
            repoId,
            temporalWorkflowId: `sp-pg-${workRequestId}`,
            workRequestId,
          },
          runInput: {
            connectionId: repoId,
            description: 'pg test',
            externalTicketId: workRequestId,
            id: workRequestId,
            requestedById: null,
            requestedByServiceId: principalId,
            requestPayload: '{}',
            ticketIsSynthetic: true,
          },
        },
        // Slow start, so the first launch's transaction has committed before the second's
        // guard could have read a stale count without the lock.
        () => new Promise((r) => setTimeout(r, 50)),
        { guard: servicePrincipalLaunchGuard(principalId, { connectionId: repoId }) }
      );
    };
    const results = await Promise.all([launch(), launch()]);
    const ok = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(refused).toEqual([
      { ok: false, reason: 'GUARD_REFUSED', refusal: SERVICE_LAUNCH_REFUSALS.inFlightLimit },
    ]);
    expect(await prisma.runInput.count({ where: { requestedByServiceId: principalId } })).toBe(1);
  });
});
