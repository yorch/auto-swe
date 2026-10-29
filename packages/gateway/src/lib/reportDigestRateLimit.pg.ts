import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimReportDigestTestSend } from './reportDigestRateLimit.js';

/**
 * Imported by mcpOAuthServer.pg.test.ts and enabled with MCP_OAUTH_PG_TEST=1
 * against a migrated throwaway PostgreSQL database.
 */
const enabled = process.env.MCP_OAUTH_PG_TEST === '1';
const suffix = Math.random().toString(36).slice(2);
const orgName = `report-digest-pg-${suffix}`;
const createdById = '00000000-0000-4000-8000-000000000001';
let orgId: string | undefined;
let subscriptionId: string | undefined;

const unscoped = <T>(fn: () => Promise<T>) =>
  runUnscoped(
    'the report digest rate-limit test manages only its unique fixtures',
    ['ReportDigestSubscription', 'Organization'],
    fn
  );

describe.skipIf(!enabled)('report digest send-test rate limit against Postgres', () => {
  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: orgName, slug: orgName },
    });
    orgId = org.id;
    const subscription = await unscoped(() =>
      prisma.reportDigestSubscription.create({
        data: { createdById, orgId, scope: 'ORGANIZATION' },
      })
    );
    subscriptionId = subscription.id;
  });

  afterAll(async () => {
    if (subscriptionId) {
      await runUnscoped(
        'the report digest rate-limit test removes only its unique subscription fixture',
        ['ReportDigestSubscription'],
        () => prisma.reportDigestSubscription.deleteMany({ where: { id: subscriptionId } })
      );
    }
    if (orgId) {
      await prisma.organization.deleteMany({ where: { id: orgId } });
    }
  });

  it('allows one atomic claim per minute and releases it after the window', async () => {
    const id = subscriptionId;
    if (!id) {
      throw new Error('Missing subscription fixture');
    }
    const first = new Date('2026-11-01T12:00:00Z');
    await expect(claimReportDigestTestSend(prisma, id, first)).resolves.toBe(true);
    await expect(
      claimReportDigestTestSend(prisma, id, new Date(first.getTime() + 60_000))
    ).resolves.toBe(false);
    await expect(
      claimReportDigestTestSend(prisma, id, new Date(first.getTime() + 60_001))
    ).resolves.toBe(true);
  });
});
