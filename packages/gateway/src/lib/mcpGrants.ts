import type { Prisma, PrismaClient } from '@auto-swe/shared';

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

/** Revocation also runs inside the caller's transaction (deactivating a user). */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * An authorization code the provider has issued but the client has not yet exchanged. They
 * live in better-auth's `verification` table; the value is JSON carrying the user and the
 * original request (`query.client_id`).
 */
function isPendingCodeFor(value: string, userId: string, clientId: string | undefined): boolean {
  try {
    const parsed = JSON.parse(value) as {
      query?: { client_id?: unknown };
      type?: unknown;
      userId?: unknown;
    };
    return (
      parsed.type === 'authorization_code' &&
      parsed.userId === userId &&
      (clientId === undefined || parsed.query?.client_id === clientId)
    );
  } catch {
    return false;
  }
}

/**
 * Revokes the user's grants: one client's when `clientId` is given, otherwise all of them.
 * `actorId` is whoever did it (the user, or the admin who deactivated the account), and
 * lands in the audit row written in the same transaction as the revocation.
 *
 * Pending authorization codes are deleted too. The code grant never looks for a consent, so a
 * client that held an unexchanged code through a disconnect could exchange it afterwards for
 * a refresh token that a later consent would bring back to life.
 *
 * Returns whether there was anything to revoke: a consent row, a live token or a pending code.
 */
export async function revokeMcpGrants(
  db: Db,
  args: { actorId: string; clientId?: string; userId: string }
): Promise<boolean> {
  const { actorId, clientId, userId } = args;
  const scope = clientId === undefined ? { userId } : { clientId, userId };
  const work = async (tx: Prisma.TransactionClient) => {
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
    const candidates = await tx.verification.findMany({
      select: { id: true, value: true },
      where: { value: { contains: userId } },
    });
    const codeIds = candidates
      .filter((row) => isPendingCodeFor(row.value, userId, clientId))
      .map((row) => row.id);
    if (codeIds.length > 0) {
      await tx.verification.deleteMany({ where: { id: { in: codeIds } } });
    }
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
    const orphaned = refresh.count + access.count + codeIds.length;
    if (consents.length === 0 && orphaned > 0) {
      // Tokens or codes outlived their consent (an earlier partial failure, or the provider's
      // own deletion). There is no consent id to name, and `entity_id` is a uuid column, so
      // the entity is the user whose access was revoked; the client is in the before-state.
      await tx.configAuditLog.create({
        data: {
          action: 'DELETE',
          actorId,
          afterJson: null as never,
          beforeJson: {
            accessTokens: access.count,
            clientId: clientId ?? null,
            consent: null,
            pendingCodes: codeIds.length,
            refreshTokens: refresh.count,
            userId,
          } as never,
          entityId: userId,
          entityType: MCP_GRANT_ENTITY,
        },
      });
    }
    return consents.length > 0 || orphaned > 0;
  };
  return '$transaction' in db ? db.$transaction(work) : work(db);
}
