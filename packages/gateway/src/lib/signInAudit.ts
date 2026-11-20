import type { PrismaClient } from '@auto-swe/shared';
import {
  type ActivityEventRow,
  AUTH_EVENT_DEDUPE_MS,
  currentActivityQueue,
} from './activityEvents.js';
import { currentAuditContext, truncateIp } from './auditContext.js';
import {
  type AuthEndpointShape,
  classifySignInFailure,
  isSignInPath,
  type SignInMethod,
  signInMethodFor,
} from './authMethod.js';
import { recordSignInFailed } from './metrics.js';
import { parseUserAgent } from './userAgent.js';

/** The slice of a better-auth endpoint context these hooks read. */
export interface AuthHookContext extends AuthEndpointShape {
  headers?: Headers | null;
  request?: { headers?: Headers | null } | null;
  context?: {
    returned?: unknown;
    secret?: string;
    authCookies?: { sessionToken: { name: string } };
    internalAdapter?: {
      findSession: (token: string) => Promise<{ session?: { userId?: string } | null } | null>;
    };
  } | null;
  getSignedCookie?: (name: string, secret: string) => Promise<string | null | undefined>;
}

function userAgentOf(ctx: {
  headers?: Headers | null;
  request?: { headers?: Headers | null } | null;
}) {
  const raw = ctx.request?.headers?.get('user-agent') ?? ctx.headers?.get('user-agent') ?? null;
  return parseUserAgent(raw);
}

/**
 * Write one auth activity row. It goes through the gateway's activity queue when that is running,
 * so it shares the dedupe and the per-actor buckets; otherwise it is written directly. Never
 * throws and never waits on the database, because it must not delay or alter the sign-in.
 */
function emitAuthEvent(
  db: Pick<PrismaClient, 'userActivityEvent'>,
  row: ActivityEventRow,
  method: SignInMethod
): void {
  try {
    const queue = currentActivityQueue();
    if (queue) {
      queue.enqueue(row, {
        key: `${row.kind}|${row.actorId}|${method}`,
        ttlMs: AUTH_EVENT_DEDUPE_MS,
      });
      return;
    }
    void db.userActivityEvent
      .create({ data: { ...row, props: row.props ?? undefined } })
      .catch((err: unknown) => {
        console.error(`[better-auth] failed to record the ${row.kind} event:`, err);
      });
  } catch (err) {
    console.error(`[better-auth] failed to record the ${row.kind} event:`, err);
  }
}

function baseRow(
  kind: ActivityEventRow['kind'],
  actorId: string,
  route: string,
  props: ActivityEventRow['props'],
  fallbackIp?: string | null
): ActivityEventRow {
  const fromRequest = currentAuditContext();
  return {
    actorId,
    ip: fromRequest ? (fromRequest.ip ?? null) : (truncateIp(fallbackIp) ?? null),
    kind,
    method: 'AUTH',
    props,
    requestId: fromRequest?.requestId ?? null,
    route,
    status: null,
    via: 'session',
  };
}

/**
 * Record a sign-in: one `Session` audit row per session created, and a `sign_in` activity event
 * carrying the method and the coarse browser. Never throws, because an audit failure must not
 * fail the sign-in it describes. The address comes from the request's audit
 * context (`request.ip`, which honours TRUST_PROXY) because better-auth fills `session.ipAddress`
 * from X-Forwarded-For whatever the proxy setting. It falls back to the session row's address
 * only when the hook runs outside a request.
 */
export async function recordSignInAudit(
  db: Pick<PrismaClient, 'configAuditLog' | 'userActivityEvent'>,
  session: { id: string; userId: string; ipAddress?: string | null; userAgent?: string | null },
  hookContext?: AuthHookContext | null
): Promise<void> {
  let method: SignInMethod = 'unknown';
  try {
    method = hookContext ? signInMethodFor(hookContext) : 'unknown';
    const fromRequest = currentAuditContext();
    const ip = fromRequest ? fromRequest.ip : truncateIp(session.ipAddress);
    await db.configAuditLog.create({
      data: {
        action: 'CREATE',
        actorId: session.userId,
        afterJson: { event: 'sign_in', method },
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
  try {
    const hasHeaders = Boolean(hookContext?.request?.headers ?? hookContext?.headers);
    const ua =
      hookContext && hasHeaders ? userAgentOf(hookContext) : parseUserAgent(session.userAgent);
    emitAuthEvent(
      db,
      baseRow('sign_in', session.userId, `auth:${method}`, { ...ua, method }, session.ipAddress),
      method
    );
  } catch (err) {
    console.error(
      `[better-auth] failed to record the sign-in event of user ${session.userId}:`,
      err
    );
  }
}

/**
 * `hooks.after`: a sign-in endpoint that returned an error is a failed attempt. It is always
 * counted; a row is written only when the attempted email names an existing user, so the table
 * never holds a person's guess at someone else's address, and never the address itself. Reads
 * only, never throws, never returns a value, so the auth response is untouched.
 */
export async function observeSignInResult(
  db: Pick<PrismaClient, 'user' | 'userActivityEvent'>,
  ctx: AuthHookContext
): Promise<void> {
  try {
    if (!isSignInPath(ctx.path)) {
      return;
    }
    const reason = classifySignInFailure(ctx.context?.returned);
    if (!reason) {
      return;
    }
    const method = signInMethodFor(ctx);
    recordSignInFailed(method);
    const email =
      ctx.path === '/sign-in/email' &&
      ctx.body &&
      typeof (ctx.body as { email?: unknown }).email === 'string'
        ? (ctx.body as { email: string }).email.trim().toLowerCase()
        : null;
    if (!email) {
      return;
    }
    const user = await db.user.findUnique({ select: { id: true }, where: { email } });
    if (!user) {
      return;
    }
    emitAuthEvent(
      db,
      baseRow('sign_in_failed', user.id, `auth:${method}`, { ...userAgentOf(ctx), method, reason }),
      method
    );
  } catch (err) {
    console.error('[better-auth] failed to record a failed sign-in:', err);
  }
}

/**
 * `hooks.before` on `/sign-out`: the session is still readable here, so the person can be named.
 * Reads only, never throws, never returns a value.
 */
export async function observeSignOut(
  db: Pick<PrismaClient, 'userActivityEvent'>,
  ctx: AuthHookContext
): Promise<void> {
  try {
    if (ctx.path !== '/sign-out' || !ctx.getSignedCookie || !ctx.context) {
      return;
    }
    const { secret, authCookies, internalAdapter } = ctx.context;
    if (!secret || !authCookies || !internalAdapter) {
      return;
    }
    const token = await ctx.getSignedCookie(authCookies.sessionToken.name, secret);
    if (!token) {
      return;
    }
    const found = await internalAdapter.findSession(token);
    const userId = found?.session?.userId;
    if (!userId) {
      return;
    }
    emitAuthEvent(db, baseRow('sign_out', userId, 'auth:sign_out', userAgentOf(ctx)), 'unknown');
  } catch (err) {
    console.error('[better-auth] failed to record a sign-out:', err);
  }
}
