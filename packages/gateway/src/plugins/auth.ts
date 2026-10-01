import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Role } from '@auto-swe/shared';
import { roleMeets } from '@auto-swe/shared/config/permissions';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
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
      /**
       * Verify an access JWT and re-read its subject from the database.
       *
       * The signature only proves what the user's role was when the token was
       * minted, up to {@link ACCESS_TOKEN_TTL_SECONDS} ago. The returned payload
       * carries the user's *current* role, and the call rejects a token whose
       * user has since been deactivated or deleted.
       */
      verifyAccessToken: (token: string) => Promise<JwtPayload>;
      /**
       * Signature, expiry and audience only — no database read, so the claims
       * are NOT authorization. For callers that need a cheap, unforgeable
       * identity before routing (the rate limiter's bucket key).
       */
      verifyAccessTokenClaims: (token: string) => JwtPayload;
      hashToken: (token: string) => string;
      /** Sign a single-purpose, short-lived token for OAuth `state`. Audience-
       *  scoped so it can never be replayed as an API bearer (and vice versa). */
      signOAuthState: (sub: string, purpose: OAuthStatePurpose) => string;
      verifyOAuthState: (token: string, purpose: OAuthStatePurpose) => { sub: string };
    };
  }
  interface FastifyRequest {
    user?: JwtPayload;
    teamRole?: string;
    /**
     * How the GitHub permission gate is configured for this request.
     *
     * Resolved once here rather than in each handler: the visibility filters
     * are pure synchronous functions called inside `where` literals, so making
     * them resolve their own config would mean awaiting mid-expression at
     * around twenty call sites. Behind the setting registry's ~30s cache, so
     * this is a memory read in the steady state.
     */
    repoAccessGate?: RepoAccessGate;
  }
}

// Role hierarchy: ADMIN > LEAD > ENGINEER. The ladder itself lives in
// `@auto-swe/shared/config/permissions`, because the settings registry's
// `requiredRole` floor has to rank roles the same way every other check in this
// file does — two copies would let the two drift apart silently.
function hasRole(userRole: string, requiredRole: string): boolean {
  return roleMeets(userRole as Role, requiredRole as Role);
}

// Org role hierarchy: ORG_ADMIN > ORG_MEMBER (P5 multi-org RBAC).
const ORG_ROLE_HIERARCHY: Record<string, number> = {
  ORG_ADMIN: 2,
  ORG_MEMBER: 1,
};

function hasOrgRole(userRole: string, requiredRole: string): boolean {
  return (ORG_ROLE_HIERARCHY[userRole] ?? 0) >= (ORG_ROLE_HIERARCHY[requiredRole] ?? 0);
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

/** Access-token lifetime, exported so the session-token bridge reports the same value. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
const ACCESS_TOKEN_TTL = ACCESS_TOKEN_TTL_SECONDS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Audience claims keep token classes from being swapped: an API access token
// can't be presented as OAuth `state`, and an OAuth-state token can't be used
// as an API bearer. Both are enforced at verify time.
const ACCESS_TOKEN_AUDIENCE = 'auto-swe:api';
const OAUTH_STATE_AUDIENCE = 'auto-swe:oauth-state';
/**
 * Each OAuth flow mints its own state purpose so a token minted by the
 * ENGINEER-level user-link flow can never complete the ADMIN-only bot
 * install (or vice versa). Verified as an exact match at the callback.
 */
export type OAuthStatePurpose = 'slack-link' | 'slack-install';
const OAUTH_STATE_TTL = '10m';

const JWT_DEV_FALLBACK = 'dev-secret-change-me';

// The dev fallback is acceptable only when NODE_ENV explicitly opts into a
// non-production environment. Treating "unset" as production means a deploy
// that forgets to set NODE_ENV fails fast instead of silently signing tokens
// with a publicly known string.
function devSecretAllowed(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

/**
 * `JWT_SECRET`, with an empty or whitespace-only value treated as unset.
 * `.env.example` ships a blank `JWT_SECRET=` line and both dotenv and Compose
 * pass it through as `''`; `??` alone would keep that empty string, which
 * slips past the dev-fallback guard below and leaves HS256 with no key.
 */
function jwtSecretOrFallback(): string {
  const raw = process.env.JWT_SECRET;
  return raw?.trim() ? raw : JWT_DEV_FALLBACK;
}

function getPrivateKey(): string {
  const keyPath = process.env.JWT_PRIVATE_KEY_PATH;
  if (keyPath) {
    return fs.readFileSync(keyPath, 'utf-8');
  }
  // Fallback for development: use a shared secret (HS256).
  const secret = jwtSecretOrFallback();
  if (!devSecretAllowed() && secret === JWT_DEV_FALLBACK) {
    throw new Error(
      'JWT_SECRET (or JWT_PRIVATE_KEY_PATH) must be set outside development/test — refusing to sign with the dev fallback.'
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
  // guard as getPrivateKey() so a misconfigured prod deployment can't
  // silently verify tokens signed with the dev fallback.
  const secret = jwtSecretOrFallback();
  if (!devSecretAllowed() && secret === JWT_DEV_FALLBACK) {
    throw new Error(
      'JWT_SECRET (or JWT_PUBLIC_KEY_PATH) must be set outside development/test — refusing to verify with the dev fallback.'
    );
  }
  return secret;
}

function getAlgorithm(): jwt.Algorithm {
  // Use RS256 if key files are provided, otherwise HS256 for dev
  return process.env.JWT_PRIVATE_KEY_PATH ? 'RS256' : 'HS256';
}

/** A validly signed access token whose user is inactive or gone. */
class TokenUserRevokedError extends Error {
  constructor() {
    super('The user this token was issued to is inactive or no longer exists');
    this.name = 'TokenUserRevokedError';
  }
}

/** The user lookup behind a token check failed — the database, not the token. */
class TokenUserLookupError extends Error {
  constructor(cause: unknown) {
    super('Could not load the user for this access token', { cause });
    this.name = 'TokenUserLookupError';
  }
}

/** The live user fields an access token's claims are re-checked against. */
interface TokenUserState {
  isActive: boolean;
  role: Role;
  slackId: string | null;
}

/**
 * Short-lived cache of {@link TokenUserState} by user id, so a bearer-token
 * request does not cost a users-table read in the steady state. The TTL bounds
 * how long a demotion or deactivation can lag on a node that was not the one
 * the change was made on; the node that made it drops the entry at once
 * through {@link invalidateUserAuthCache}.
 */
const TOKEN_USER_CACHE_TTL_MS = 30_000;
const TOKEN_USER_CACHE_MAX = 2000;
const tokenUserCache = new Map<string, { state: TokenUserState | null; expiresAt: number }>();

async function loadTokenUser(
  prisma: FastifyInstance['prisma'],
  userId: string
): Promise<TokenUserState | null> {
  const hit = tokenUserCache.get(userId);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.state;
  }
  const row = await prisma.user.findUnique({
    select: { isActive: true, role: true, slackId: true },
    where: { id: userId },
  });
  if (!hit && tokenUserCache.size >= TOKEN_USER_CACHE_MAX) {
    const firstKey = tokenUserCache.keys().next().value;
    if (firstKey !== undefined) {
      tokenUserCache.delete(firstKey);
    }
  }
  tokenUserCache.set(userId, { expiresAt: Date.now() + TOKEN_USER_CACHE_TTL_MS, state: row });
  return row;
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const privateKey = getPrivateKey();
  const publicKey = getPublicKey();
  const algorithm = getAlgorithm();

  fastify.decorate('auth', {
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

    signOAuthState(sub: string, purpose: OAuthStatePurpose): string {
      return jwt.sign({ purpose, sub }, privateKey, {
        algorithm,
        audience: OAUTH_STATE_AUDIENCE,
        expiresIn: OAUTH_STATE_TTL,
      });
    },

    async verifyAccessToken(token: string): Promise<JwtPayload> {
      const claims = fastify.auth.verifyAccessTokenClaims(token);
      // The role claim is a snapshot from mint time. Authorize on the user as
      // they are now: a demoted user must not keep the old role for the rest of
      // the token's lifetime, and a deactivated one must not keep access at all.
      const user = await loadTokenUser(fastify.prisma, claims.sub).catch((err: unknown) => {
        throw new TokenUserLookupError(err);
      });
      if (!user?.isActive) {
        throw new TokenUserRevokedError();
      }
      const { slackId: _staleSlackId, ...rest } = claims;
      return {
        ...rest,
        role: user.role,
        ...(user.slackId ? { slackId: user.slackId } : {}),
      };
    },

    verifyAccessTokenClaims(token: string): JwtPayload {
      return jwt.verify(token, publicKey, {
        algorithms: [algorithm],
        audience: ACCESS_TOKEN_AUDIENCE,
      }) as JwtPayload;
    },

    verifyOAuthState(token: string, purpose: OAuthStatePurpose): { sub: string } {
      const decoded = jwt.verify(token, publicKey, {
        algorithms: [algorithm],
        audience: OAUTH_STATE_AUDIENCE,
      }) as { sub: string; purpose?: string };
      if (decoded.purpose !== purpose) {
        throw new Error('OAuth state was minted for a different flow');
      }
      return { sub: decoded.sub };
    },
  });
};

export { authPlugin, hasRole };
export default fp(authPlugin, { fastify: '5.x', name: 'auth' });

// ── RBAC Hook Factory ──

export interface RBACOptions {
  requiredRole?: string; // Platform role check
  requiredTeamRole?: string; // Team-scoped role check (resolves via team membership)
  teamIdParam?: string; // Route param name containing the team ID (default: 'id')
  requiredOrgRole?: string; // Org-scoped role check (resolves via org membership)
  orgIdParam?: string; // Route param name containing the org ID (default: 'orgId')
}

/**
 * Creates a Fastify onRequest hook that enforces JWT authentication
 * and optional role-based access control.
 *
 * When `requiredTeamRole` is set with a `teamIdParam`, the middleware resolves
 * the user's membership in that team and checks their team role. Likewise,
 * `requiredOrgRole` with `orgIdParam` resolves org membership and checks the
 * org role (ORG_ADMIN > ORG_MEMBER). Platform ADMINs bypass team/org checks.
 */
/** Phase-8 personal access tokens are prefixed with `ats_`. The remainder is
 * 32 bytes of base64url entropy (~43 chars). Anything starting with this
 * prefix bypasses JWT verification and hashes through PersonalAccessToken
 * instead. JWTs continue to round-trip the existing RS256/HS256 path.
 *
 * Canonical home for this constant — `routes/tokens.ts` (which mints the
 * tokens) imports it from here so the mint and verify paths can never drift. */
export const PAT_PREFIX = 'ats_';

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
// Session-revocation lag window: a revoked session can still authenticate for
// up to this long. Env-overridable (deploy-time knob); defaults unchanged at
// 60s. `Number(x) || default` also falls through on NaN, which is fine here.
const SESSION_CACHE_TTL_MS = Number(process.env.SESSION_CACHE_TTL_MS) || 60_000;
const SESSION_CACHE_MAX = 2000;
// Keyed by the cookie value as the browser sends it, which better-auth signs:
// `<session token>.<signature>`. The database stores only the unsigned token,
// so invalidation by token has to match on the prefix — see
// `invalidateSessionCache`.
const sessionPayloadCache = new Map<string, { payload: JwtPayload; expiresAt: number }>();

/** Extract the better-auth session token from a cookie header string.
 *  Quick scan for the one cookie name we care about — no full parse.
 *  Exported so index.ts shares this instead of keeping its own copy. */
export function extractSessionCookieValue(headers: FastifyRequest['headers']): string | null {
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
  const [{ getAuth }, { fromNodeHeaders }] = await Promise.all([
    import('../lib/betterAuth.js'),
    import('better-auth/node'),
  ]);
  const session = await getAuth().api.getSession({
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

/**
 * Drop a session from the in-memory cache, so a signed-out or revoked session
 * stops authenticating now instead of after the TTL.
 *
 * Accepts either form of the token: the signed cookie value (`<token>.<sig>`,
 * what sign-out has in hand) or the bare token as stored in `sessions.token`
 * (what an admin revocation reads from the database). The cache is keyed by
 * the signed form, so a bare token matches every entry it is the signed prefix
 * of — an exact-key delete alone would never match it.
 */
export function invalidateSessionCache(sessionToken: string): void {
  sessionPayloadCache.delete(sessionToken);
  const signedPrefix = `${sessionToken}.`;
  for (const key of sessionPayloadCache.keys()) {
    if (key.startsWith(signedPrefix)) {
      sessionPayloadCache.delete(key);
    }
  }
}

/**
 * Drop everything this process has cached about a user's authentication —
 * every cached browser session and the bearer-token user state — so a role
 * change or deactivation applies to the next request rather than after a TTL.
 */
export function invalidateUserAuthCache(userId: string): void {
  tokenUserCache.delete(userId);
  for (const [key, entry] of sessionPayloadCache) {
    if (entry.payload.sub === userId) {
      sessionPayloadCache.delete(key);
    }
  }
}

/**
 * The IP half of {@link rateLimitKey}, and the whole key for the credential
 * routes. Normalised exactly as the plugin's default key generator does: an
 * IPv6 client is bucketed by its /64, not its full address. Supplying any
 * custom `keyGenerator` switches that normalisation off, and a raw IPv6 key
 * lets one client rotate through its /64 for a fresh bucket per request.
 */
export function ipRateLimitKey(request: FastifyRequest): string {
  return `ip:${normalizeIP(request.ip)}`;
}

/**
 * The rate-limit bucket for a request: the caller's user id when this process
 * can prove who they are without a database read, otherwise their IP.
 *
 * Only an identity that has already been verified may pick a bucket. A key
 * taken from an unverified header would let a client mint a fresh bucket per
 * request by sending a new random token each time, which is the same as having
 * no limit. So: a Bearer JWT counts once its signature verifies, and a session
 * cookie counts once it is in the session cache (which only holds sessions
 * better-auth has confirmed). A PAT, an unknown cookie, or anything invalid
 * falls back to the IP — the authentication hook rejects the bad ones anyway.
 *
 * Without this, every server-side render from the web app shares the web
 * server's IP, and one busy dashboard exhausts the limit for every user.
 */
export function rateLimitKey(request: FastifyRequest): string {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (!token.startsWith(PAT_PREFIX)) {
      try {
        return `user:${request.server.auth.verifyAccessTokenClaims(token).sub}`;
      } catch {
        // Invalid token: fall through to the IP.
      }
    }
    return ipRateLimitKey(request);
  }
  const cookie = extractSessionCookieValue(request.headers);
  if (cookie) {
    const hit = sessionPayloadCache.get(cookie);
    if (hit && hit.expiresAt > Date.now()) {
      return `user:${hit.payload.sub}`;
    }
  }
  return ipRateLimitKey(request);
}

/** Test seam: seed a session-cache entry as a verified session would. */
export function _cacheSessionForTests(cookieValue: string, payload: JwtPayload): void {
  sessionPayloadCache.set(cookieValue, { expiresAt: Date.now() + 60_000, payload });
}

/** Test seam: empty both authentication caches. */
export function _resetAuthCachesForTests(): void {
  sessionPayloadCache.clear();
  tokenUserCache.clear();
}

/** Test seam: whether a session-cache entry is present. */
export function _hasCachedSessionForTests(cookieValue: string): boolean {
  return sessionPayloadCache.has(cookieValue);
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
          : await request.server.auth.verifyAccessToken(token);
      } catch (err: unknown) {
        if (err instanceof PatAuthError) {
          return reply.status(401).send({ error: { code: err.code, message: err.message } });
        }
        // A failed user lookup is an outage, not a verdict on the caller, and
        // its message is internal: surface it as a server error, not a 401.
        if (err instanceof TokenUserLookupError) {
          throw err;
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

    // A failure to read the gate must not fail the request, but it must not
    // silently disable enforcement either — that would allow launches that were
    // being refused a second earlier, invisibly to the person it lets through.
    // The resolver falls back to the last value this process read; only a
    // process that has never managed to read it falls all the way to `off`,
    // and such a process has nothing to enforce yet.
    const gate = await resolveRepoAccessGateOrLastKnown();
    if (!gate) {
      request.log.warn('repo access gate config has never been readable; treating as off');
    }
    request.repoAccessGate = gate ?? { mode: 'off', staleAfterHours: 0 };

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
        // The route promised a team ID param but did not declare one. This is a
        // server misconfiguration, not a client error, so it stays a 500.
        return reply.status(500).send({
          error: { code: 'SERVER_ERROR', message: 'Team ID route parameter missing' },
        });
      }
      if (!UUID_RE.test(teamId)) {
        return reply.status(400).send({
          error: { code: 'INVALID_ID', message: 'Team ID must be a valid UUID' },
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

    // Org role check: resolve org membership and enforce (P5 multi-org RBAC)
    if (options.requiredOrgRole) {
      // Platform ADMIN bypasses org checks
      if (payload.role === 'ADMIN') {
        return;
      }

      const orgId = (request.params as Record<string, string>)?.[options.orgIdParam ?? 'orgId'];
      if (!orgId) {
        // The route promised an org ID param but did not declare one. This is a
        // server misconfiguration, not a client error, so it stays a 500.
        return reply.status(500).send({
          error: { code: 'SERVER_ERROR', message: 'Organization ID route parameter missing' },
        });
      }
      if (!UUID_RE.test(orgId)) {
        return reply.status(400).send({
          error: { code: 'INVALID_ID', message: 'Organization ID must be a valid UUID' },
        });
      }

      const prisma = request.server.prisma;
      const membership = await prisma.organizationMembership.findUnique({
        where: { userId_orgId: { orgId, userId: payload.sub } },
      });

      if (!membership || !hasOrgRole(membership.role, options.requiredOrgRole)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: `Requires ${options.requiredOrgRole} role in this organization`,
          },
        });
      }
    }
  };
}
