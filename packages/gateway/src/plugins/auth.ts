import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Role } from '@auto-swe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';

// ── JWT Configuration ──

export interface JwtPayload {
  sub: string; // User UUID
  role: Role;
  slackId?: string;
  iat: number;
  exp: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    auth: {
      signAccessToken: (payload: Omit<JwtPayload, 'iat' | 'exp'>) => string;
      verifyAccessToken: (token: string) => JwtPayload;
      generateRefreshToken: () => string;
      hashToken: (token: string) => string;
      /** Sign a single-purpose, short-lived token for OAuth `state`. Audience-
       *  scoped so it can never be replayed as an API bearer (and vice versa). */
      signOAuthState: (sub: string) => string;
      verifyOAuthState: (token: string) => { sub: string };
    };
  }
  interface FastifyRequest {
    user?: JwtPayload;
    teamRole?: string;
  }
}

// Role hierarchy: ADMIN > LEAD > ENGINEER
const ROLE_HIERARCHY: Record<string, number> = {
  ADMIN: 3,
  ENGINEER: 1,
  LEAD: 2,
};

function hasRole(userRole: string, requiredRole: string): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[requiredRole] ?? 0);
}

/**
 * Asserts that requireAuth middleware ran and narrows request.user to JwtPayload.
 * Use inside route handlers that include requireAuth() in their onRequest hook.
 */
export function requireUser(request: FastifyRequest): JwtPayload {
  if (!request.user) {
    throw new Error('requireUser called without requireAuth middleware');
  }
  return request.user;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getErrorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

export { getErrorMessage, getErrorName };

const ACCESS_TOKEN_TTL = '1h';
const REFRESH_TOKEN_BYTES = 48;

// Audience claims keep token classes from being swapped: an API access token
// can't be presented as OAuth `state`, and an OAuth-state token can't be used
// as an API bearer. Both are enforced at verify time.
const ACCESS_TOKEN_AUDIENCE = 'auto-swe:api';
const OAUTH_STATE_AUDIENCE = 'auto-swe:oauth-state';
const OAUTH_STATE_TTL = '10m';

const JWT_DEV_FALLBACK = 'dev-secret-change-me';

function getPrivateKey(): string {
  const keyPath = process.env.JWT_PRIVATE_KEY_PATH;
  if (keyPath) {
    return fs.readFileSync(keyPath, 'utf-8');
  }
  // Fallback for development: use a shared secret (HS256).
  const secret = process.env.JWT_SECRET ?? JWT_DEV_FALLBACK;
  if (process.env.NODE_ENV === 'production' && secret === JWT_DEV_FALLBACK) {
    throw new Error(
      'JWT_SECRET (or JWT_PRIVATE_KEY_PATH) must be set in production — refusing to sign with the dev fallback.'
    );
  }
  return secret;
}

function getPublicKey(): string {
  const keyPath = process.env.JWT_PUBLIC_KEY_PATH;
  if (keyPath) {
    return fs.readFileSync(keyPath, 'utf-8');
  }
  // Fallback for development: same shared secret (HS256). Apply the same
  // production guard as getPrivateKey() so a misconfigured prod deployment
  // can't silently verify tokens signed with the dev fallback.
  const secret = process.env.JWT_SECRET ?? JWT_DEV_FALLBACK;
  if (process.env.NODE_ENV === 'production' && secret === JWT_DEV_FALLBACK) {
    throw new Error(
      'JWT_SECRET (or JWT_PUBLIC_KEY_PATH) must be set in production — refusing to verify with the dev fallback.'
    );
  }
  return secret;
}

function getAlgorithm(): jwt.Algorithm {
  // Use RS256 if key files are provided, otherwise HS256 for dev
  return process.env.JWT_PRIVATE_KEY_PATH ? 'RS256' : 'HS256';
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const privateKey = getPrivateKey();
  const publicKey = getPublicKey();
  const algorithm = getAlgorithm();

  fastify.decorate('auth', {
    generateRefreshToken(): string {
      return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    },

    hashToken(token: string): string {
      return crypto.createHash('sha256').update(token).digest('hex');
    },
    signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
      return jwt.sign(payload, privateKey, {
        algorithm,
        audience: ACCESS_TOKEN_AUDIENCE,
        expiresIn: ACCESS_TOKEN_TTL,
      });
    },

    signOAuthState(sub: string): string {
      return jwt.sign({ sub }, privateKey, {
        algorithm,
        audience: OAUTH_STATE_AUDIENCE,
        expiresIn: OAUTH_STATE_TTL,
      });
    },

    verifyAccessToken(token: string): JwtPayload {
      return jwt.verify(token, publicKey, {
        algorithms: [algorithm],
        audience: ACCESS_TOKEN_AUDIENCE,
      }) as JwtPayload;
    },

    verifyOAuthState(token: string): { sub: string } {
      const decoded = jwt.verify(token, publicKey, {
        algorithms: [algorithm],
        audience: OAUTH_STATE_AUDIENCE,
      }) as { sub: string };
      return { sub: decoded.sub };
    },
  });
};

export { authPlugin, hasRole, ROLE_HIERARCHY };
export default fp(authPlugin, { fastify: '5.x', name: 'auth' });

// ── RBAC Hook Factory ──

export interface RBACOptions {
  requiredRole?: string; // Platform role check
  requiredTeamRole?: string; // Team-scoped role check (resolves via team membership)
  teamIdParam?: string; // Route param name containing the team ID (default: 'id')
}

/**
 * Creates a Fastify onRequest hook that enforces JWT authentication
 * and optional role-based access control.
 *
 * When `requiredTeamRole` is set with a `teamIdParam`, the middleware resolves
 * the user's membership in that team and checks their team role. Platform ADMINs
 * bypass team checks.
 */
/** Phase-8 personal access tokens are prefixed with `ats_`. The remainder is
 * 32 bytes of base64url entropy (~43 chars). Anything starting with this
 * prefix bypasses JWT verification and hashes through PersonalAccessToken
 * instead. JWTs continue to round-trip the existing RS256/HS256 path. */
const PAT_PREFIX = 'ats_';

class PatAuthError extends Error {
  readonly code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED';
  constructor(code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED', message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Resolve a `ats_*` personal access token into a synthesized `JwtPayload`
 * so downstream RBAC behaves identically to JWT auth. Throws {@link PatAuthError}
 * with a typed code on rejection; the caller maps it to a 401 response.
 */
async function verifyPatPayload(request: FastifyRequest, token: string): Promise<JwtPayload> {
  const hash = request.server.auth.hashToken(token);
  const pat = await request.server.prisma.personalAccessToken.findUnique({
    include: { user: true },
    where: { tokenHash: hash },
  });
  if (!pat || pat.revokedAt || !pat.user.isActive) {
    throw new PatAuthError('TOKEN_INVALID', 'Invalid or revoked access token');
  }
  if (pat.expiresAt && pat.expiresAt < new Date()) {
    throw new PatAuthError('TOKEN_EXPIRED', 'Access token expired');
  }
  // Fire-and-forget `lastUsedAt` update so a slow write can't add latency.
  request.server.prisma.personalAccessToken
    .update({ data: { lastUsedAt: new Date() }, where: { id: pat.id } })
    .catch(() => {});
  const now = Math.floor(Date.now() / 1000);
  return {
    exp: now + 60,
    iat: now,
    role: pat.user.role,
    ...(pat.user.slackId ? { slackId: pat.user.slackId } : {}),
    sub: pat.user.id,
  };
}

/** In-memory cache for session validation results. Keyed by the raw session
 *  cookie value; entries live for SESSION_CACHE_TTL_MS. This eliminates the
 *  per-request Postgres roundtrip for steady-state browser traffic — a typical
 *  page render fires 5-15 API calls, and without the cache each would hit the
 *  sessions + users tables via better-auth's getSession.
 *
 *  Memory bound: SESSION_CACHE_MAX entries, evicted FIFO when full. At ~150
 *  bytes per entry this caps the cache at well under 1 MB. */
const SESSION_CACHE_TTL_MS = 60_000;
const SESSION_CACHE_MAX = 2000;
const sessionPayloadCache = new Map<string, { payload: JwtPayload; expiresAt: number }>();

function extractSessionCookieValue(headers: FastifyRequest['headers']): string | null {
  const raw = headers.cookie;
  if (typeof raw !== 'string') {
    return null;
  }
  // Quick scan for the better-auth session cookie name. We don't bother
  // parsing the full cookie string — just the one value we care about.
  const idx = raw.indexOf('better-auth.session_token=');
  if (idx === -1) {
    return null;
  }
  const start = idx + 'better-auth.session_token='.length;
  const end = raw.indexOf(';', start);
  return decodeURIComponent(raw.slice(start, end === -1 ? undefined : end));
}

/** Resolve a better-auth browser session cookie into a synthesized JwtPayload.
 *  Returns null when no session is present so the caller can fall through to
 *  the unauthorized response. */
async function verifyBetterAuthSession(request: FastifyRequest): Promise<JwtPayload | null> {
  // Fast path: cache hit by session-cookie value. Stale entries are dropped
  // here so the lazy expiry doesn't grow the map unbounded over time.
  const sessionToken = extractSessionCookieValue(request.headers);
  if (sessionToken) {
    const hit = sessionPayloadCache.get(sessionToken);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.payload;
    }
    if (hit) {
      sessionPayloadCache.delete(sessionToken);
    }
  }

  // Lazy-load to avoid pulling the better-auth module graph into the auth
  // plugin's hot startup path (and to avoid a cycle if betterAuth.ts ever
  // imports from this file).
  const [{ auth: betterAuth }, { fromNodeHeaders }] = await Promise.all([
    import('../lib/betterAuth.js'),
    import('better-auth/node'),
  ]);
  const session = await betterAuth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  if (!session) {
    return null;
  }
  // `session.user` carries the additionalFields we declared in betterAuth.ts
  // (role, isActive, slackId), so we no longer need a second Prisma roundtrip
  // to the users table. Type the relevant subset to satisfy TS without `any`.
  const u = session.user as {
    id: string;
    role: Role;
    isActive: boolean;
    slackId?: string | null;
  };
  if (!u.isActive) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    exp: now + 60,
    iat: now,
    role: u.role,
    ...(u.slackId ? { slackId: u.slackId } : {}),
    sub: u.id,
  };

  // Stash in the cache for follow-up requests on the same session.
  if (sessionToken) {
    if (sessionPayloadCache.size >= SESSION_CACHE_MAX) {
      // FIFO eviction — Map iteration order is insertion order.
      const firstKey = sessionPayloadCache.keys().next().value;
      if (firstKey !== undefined) {
        sessionPayloadCache.delete(firstKey);
      }
    }
    sessionPayloadCache.set(sessionToken, {
      expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
      payload,
    });
  }
  return payload;
}

/** Drop a session from the in-memory cache (used by sign-out so the user
 *  is immediately logged out instead of waiting up to 60s for the TTL). */
export function invalidateSessionCache(sessionToken: string): void {
  sessionPayloadCache.delete(sessionToken);
}

export function requireAuth(options: RBACOptions = {}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    let payload: JwtPayload | null = null;

    // Path 1: Authorization: Bearer <PAT or JWT>
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        payload = token.startsWith(PAT_PREFIX)
          ? await verifyPatPayload(request, token)
          : request.server.auth.verifyAccessToken(token);
      } catch (err: unknown) {
        if (err instanceof PatAuthError) {
          return reply.status(401).send({ error: { code: err.code, message: err.message } });
        }
        return reply.status(401).send({
          error: { code: 'TOKEN_INVALID', message: getErrorMessage(err) || 'Invalid token' },
        });
      }
    } else {
      // Path 2: better-auth session cookie — browser path that doesn't carry
      // an Authorization header. Letting requests authenticate purely on the
      // session cookie removes the need for the /api/v1/auth/session-token
      // JWT bridge in the long run.
      try {
        payload = await verifyBetterAuthSession(request);
      } catch (err) {
        request.log.warn({ err }, 'better-auth session check failed');
      }
    }

    if (!payload) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid credentials' },
      });
    }
    request.user = payload;

    // Platform role check
    if (options.requiredRole && !hasRole(payload.role, options.requiredRole)) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: `Requires ${options.requiredRole} role` },
      });
    }

    // Team role check: resolve membership and enforce
    if (options.requiredTeamRole) {
      // Platform ADMIN bypasses team checks
      if (payload.role === 'ADMIN') {
        return;
      }

      const teamId = (request.params as Record<string, string>)?.[options.teamIdParam ?? 'id'];
      if (!teamId) {
        // requiredTeamRole was set but the param is absent — this is a server-side
        // misconfiguration (wrong teamIdParam value). Fail loudly rather than
        // silently granting access.
        return reply.status(500).send({
          error: { code: 'SERVER_ERROR', message: 'Team ID param misconfigured on this route' },
        });
      }

      const prisma = request.server.prisma;
      const membership = await prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId, userId: payload.sub } },
      });

      if (!membership || !hasRole(membership.role, options.requiredTeamRole)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: `Requires ${options.requiredTeamRole} role in this team`,
          },
        });
      }

      request.teamRole = membership.role;
    }
  };
}
