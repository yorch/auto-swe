import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const postMock = vi.fn();
vi.mock('./slackNotify.js', () => ({
  postSlackChannelMessage: (...a: unknown[]) => postMock(...a),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveSlackBotTokenForSlackChannel: async () => 'xoxb-test',
}));

import { evaluateTeamBudgetNotice } from './teamBudgetNotice.js';

/**
 * The once-per-(team, month, level) marker against real Postgres: the unique key is what makes
 * concurrent evaluations send one notice, which a mocked Prisma cannot show.
 *
 * Opt in with `TEAM_BUDGET_NOTICE_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.TEAM_BUDGET_NOTICE_PG_TEST === '1';

describe.skipIf(!enabled)('team budget notices against Postgres', () => {
  const prefix = `tbn-${crypto.randomBytes(4).toString('hex')}-`;
  let orgId = '';
  let teamId = '';
  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped('test fixture: throwaway database', ['Team', 'TeamBudgetNotice'], fn);

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: `${prefix}org`, slug: `${prefix}org` } })
    ).id;
    teamId = (
      await prisma.team.create({
        data: {
          budgetAlertThresholdPercent: 80,
          monthlyBudgetUsdCents: 1000,
          name: `${prefix}team`,
          orgId,
          slackNotifyChannel: 'C123',
          slug: `${prefix}team`,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await unscoped(() => prisma.team.deleteMany({ where: { id: teamId } }));
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it('sends one warning across concurrent evaluations, then one per later level and month', async () => {
    postMock.mockResolvedValue(undefined);
    const nov = new Date('2026-11-12T10:00:00Z');
    await Promise.all([1, 2, 3, 4, 5].map(() => evaluateTeamBudgetNotice(teamId, 8, nov)));
    expect(postMock).toHaveBeenCalledTimes(1);

    await evaluateTeamBudgetNotice(teamId, 8.5, nov);
    expect(postMock).toHaveBeenCalledTimes(1);

    await Promise.all([1, 2, 3].map(() => evaluateTeamBudgetNotice(teamId, 10, nov)));
    expect(postMock).toHaveBeenCalledTimes(2);

    await evaluateTeamBudgetNotice(teamId, 8, new Date('2026-12-01T00:00:01Z'));
    expect(postMock).toHaveBeenCalledTimes(3);

    const rows = await unscoped(() => prisma.teamBudgetNotice.findMany({ where: { teamId } }));
    expect(rows.map((r) => `${r.period}/${r.level}`).sort()).toEqual([
      '2026-11/CAP_REACHED',
      '2026-11/WARNING',
      '2026-12/WARNING',
    ]);
  });

  it('releases the marker when the post fails so a later evaluation retries', async () => {
    const jan = new Date('2027-01-05T00:00:00Z');
    postMock.mockRejectedValueOnce(new Error('slack down'));
    await evaluateTeamBudgetNotice(teamId, 8, jan);
    postMock.mockResolvedValue(undefined);
    const before = postMock.mock.calls.length;
    await evaluateTeamBudgetNotice(teamId, 8, jan);
    expect(postMock.mock.calls.length).toBe(before + 1);
  });
});
