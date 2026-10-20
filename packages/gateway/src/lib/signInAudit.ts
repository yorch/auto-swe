import type { PrismaClient } from '@auto-swe/shared';
import { currentAuditContext, truncateIp } from './auditContext.js';

/**
 * Record a sign-in: one `Session` audit row per session created. Never throws, because an audit
 * failure must not fail the sign-in it describes. The address comes from the request's audit
 * context (`request.ip`, which honours TRUST_PROXY) because better-auth fills `session.ipAddress`
 * from X-Forwarded-For whatever the proxy setting. It falls back to the session row's address
 * only when the hook runs outside a request.
 */
export async function recordSignInAudit(
  db: Pick<PrismaClient, 'configAuditLog'>,
  session: { id: string; userId: string; ipAddress?: string | null }
): Promise<void> {
  try {
    const fromRequest = currentAuditContext();
    const ip = fromRequest ? fromRequest.ip : truncateIp(session.ipAddress);
    await db.configAuditLog.create({
      data: {
        action: 'CREATE',
        actorId: session.userId,
        afterJson: { event: 'sign_in' },
        context: {
          ...(fromRequest?.requestId ? { requestId: fromRequest.requestId } : {}),
          via: 'session',
          ...(ip ? { ip } : {}),
        },
        entityId: session.id,
        entityType: 'Session',
      },
    });
  } catch (err) {
    console.error(`[better-auth] failed to audit the sign-in of user ${session.userId}:`, err);
  }
}
