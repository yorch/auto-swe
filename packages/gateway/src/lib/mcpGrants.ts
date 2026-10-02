import type { PrismaClient } from '@auto-swe/shared';

/**
 * What a user has authorised MCP clients to do, and the one way to take it back.
 *
 * Deleting the consent row is not revocation. The refresh grant checks neither the consent
 * nor the account's grants, so a refresh token outlives its consent, and a later consent by
 * the same client would revive every refresh token it was ever issued. Revocation is
 * therefore one transaction that deletes the consent rows and marks every stored refresh and
 * access token for the (user, client) pair revoked. Every consent deletion goes through
 * here: the provider's own deletion endpoints are not served (see `mcpOAuthGate.ts`).
 *
 * JWT access tokens are not stored, so there is nothing to mark for them: they stop working
 * at the resource server, which requires the consent row to exist, and expire within
 * `MCP_ACCESS_TOKEN_TTL_SECONDS` regardless.
 */

export interface McpGrantSummary {
  clientId: string;
  clientName: string | null;
  /** The redirect URIs the client registered; the web app shows the host of each. */
  redirectUris: string[];
  scopes: string[];
  grantedAt: Date;
}

export const MCP_GRANT_ENTITY = 'McpGrant';

export async function listMcpGrants(
  prisma: PrismaClient,
  userId: string
): Promise<McpGrantSummary[]> {
  const rows = await prisma.oauthConsent.findMany({
    include: { client: { select: { name: true, redirectUris: true } } },
    orderBy: { createdAt: 'desc' },
    where: { userId },
  });
  return rows.map((row) => ({
    clientId: row.clientId,
    clientName: row.client.name,
    grantedAt: row.createdAt,
    redirectUris: row.client.redirectUris,
    scopes: row.scopes,
  }));
}

/**
 * Revokes the user's grants: one client's when `clientId` is given, otherwise all of them.
 * `actorId` is whoever did it (the user, or the admin who deactivated the account), and
 * lands in the audit row written in the same transaction as the revocation.
 *
 * Returns whether there was anything to revoke: a consent row or a live token.
 */
export async function revokeMcpGrants(
  prisma: PrismaClient,
  args: { actorId: string; clientId?: string; userId: string }
): Promise<boolean> {
  const { actorId, clientId, userId } = args;
  const scope = clientId === undefined ? { userId } : { clientId, userId };
  return prisma.$transaction(async (tx) => {
    const consents = await tx.oauthConsent.findMany({ where: scope });
    await tx.oauthConsent.deleteMany({ where: scope });
    const now = new Date();
    const refresh = await tx.oauthRefreshToken.updateMany({
      data: { revoked: now },
      where: { ...scope, revoked: null },
    });
    const access = await tx.oauthAccessToken.updateMany({
      data: { revoked: now },
      where: { ...scope, revoked: null },
    });
    for (const consent of consents) {
      await tx.configAuditLog.create({
        data: {
          action: 'DELETE',
          actorId,
          afterJson: null as never,
          beforeJson: {
            clientId: consent.clientId,
            scopes: consent.scopes,
            userId: consent.userId,
          } as never,
          entityId: consent.id,
          entityType: MCP_GRANT_ENTITY,
        },
      });
    }
    return consents.length > 0 || refresh.count > 0 || access.count > 0;
  });
}
