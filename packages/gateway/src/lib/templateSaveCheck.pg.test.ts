import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isUniqueConstraintError } from './prismaErrors.js';
import { templateNameTaken } from './templateSaveCheck.js';

/**
 * `templateNameTaken` against the real `(team_id, name)` unique index it mirrors. The create
 * route lets that index refuse; the check asks the same question first, so the two must agree on
 * exact (case-sensitive) comparison and on a NULL team never colliding. A mocked Prisma cannot
 * show either.
 *
 * Opt in with `TEMPLATE_NAME_PG_TEST=1` and a throwaway `DATABASE_URL` that
 * `prisma migrate deploy` has been run against:
 *
 *   TEMPLATE_NAME_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/gateway/src/lib/templateSaveCheck.pg.test.ts
 */
const enabled = process.env.TEMPLATE_NAME_PG_TEST === '1';

const unscoped = <T>(fn: () => Promise<T>) =>
  runUnscoped('template name pg test', ['WorkflowTemplate', 'Team', 'Organization'], fn);

describe.skipIf(!enabled)('templateNameTaken against Postgres', () => {
  const suffix = Math.random().toString(36).slice(2);
  const name = `Billing-${suffix}`;
  const ids: string[] = [];
  let teamId = '';
  let otherTeamId = '';
  let orgId = '';

  const make = (data: { name: string; teamId: string | null }) =>
    prisma.workflowTemplate.create({ data: { ...data, status: 'DRAFT' } });

  beforeAll(async () => {
    await unscoped(async () => {
      const org = await prisma.organization.create({
        data: { name: `org-${suffix}`, slug: `org-${suffix}` },
      });
      orgId = org.id;
      const team = (n: string) =>
        prisma.team.create({ data: { name: `${n}-${suffix}`, orgId, slug: `${n}-${suffix}` } });
      const a = await team('t1');
      const b = await team('t2');
      teamId = a.id;
      otherTeamId = b.id;
      ids.push((await make({ name, teamId })).id);
    });
  });

  afterAll(async () => {
    await unscoped(async () => {
      await prisma.workflowTemplate.deleteMany({ where: { id: { in: ids } } });
      await prisma.team.deleteMany({ where: { id: { in: [teamId, otherTeamId] } } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    });
  });

  it('is exact: another case is not a conflict, and the index agrees', async () => {
    await unscoped(async () => {
      expect(await templateNameTaken(prisma, teamId, name)).toBe(true);
      expect(await templateNameTaken(prisma, teamId, name.toLowerCase())).toBe(false);
      ids.push((await make({ name: name.toLowerCase(), teamId })).id);
    });
  });

  it('is scoped to the team, and the index agrees', async () => {
    await unscoped(async () => {
      expect(await templateNameTaken(prisma, otherTeamId, name)).toBe(false);
      ids.push((await make({ name, teamId: otherTeamId })).id);
      await expect(make({ name, teamId })).rejects.toSatisfy(isUniqueConstraintError);
    });
  });

  it('never reports a global name, because the index does not collide on a NULL team', async () => {
    await unscoped(async () => {
      const global = `Global-${suffix}`;
      ids.push((await make({ name: global, teamId: null })).id);
      expect(await templateNameTaken(prisma, null, global)).toBe(false);
      ids.push((await make({ name: global, teamId: null })).id);
    });
  });

  it('leaves out the template being renamed', async () => {
    await unscoped(async () => {
      const own = await prisma.workflowTemplate.findFirstOrThrow({ where: { name, teamId } });
      expect(await templateNameTaken(prisma, teamId, name, own.id)).toBe(false);
      expect(
        await templateNameTaken(prisma, teamId, name, '00000000-0000-4000-a000-000000000000')
      ).toBe(true);
    });
  });
});
