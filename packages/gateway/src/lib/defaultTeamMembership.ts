import type { PrismaClient } from '@auto-swe/shared';
import { auditContextData } from './auditContext.js';

export async function enrollDefaultTeam(
  db: PrismaClient,
  team: { id: string; orgId: string },
  userId: string,
  actorId: string | null
): Promise<void> {
  await db.$transaction(async (tx) => {
    const orgData = { orgId: team.orgId, role: 'ORG_MEMBER' as const, userId };
    const orgRows = await tx.organizationMembership.createMany({
      data: orgData,
      skipDuplicates: true,
    });
    if (orgRows.count) {
      const row = await tx.organizationMembership.findUniqueOrThrow({
        where: { userId_orgId: { orgId: team.orgId, userId } },
      });
      await tx.configAuditLog.create({
        data: {
          action: 'CREATE',
          actorId,
          afterJson: orgData,
          entityId: row.id,
          entityType: 'OrganizationMembership',
          ...auditContextData(),
        },
      });
    }
    const teamData = { role: 'ENGINEER' as const, teamId: team.id, userId };
    const teamRows = await tx.teamMembership.createMany({ data: teamData, skipDuplicates: true });
    if (teamRows.count) {
      const row = await tx.teamMembership.findUniqueOrThrow({
        where: { userId_teamId: { teamId: team.id, userId } },
      });
      await tx.configAuditLog.create({
        data: {
          action: 'CREATE',
          actorId,
          afterJson: teamData,
          entityId: row.id,
          entityType: 'TeamMembership',
          ...auditContextData(),
        },
      });
    }
  });
}
