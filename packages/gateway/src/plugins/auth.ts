import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Role } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { roleMeets } from '@auto-swe/shared/config/permissions';
import {
  ASSISTANT_ACTION_HEADER,
  ASSISTANT_TOKEN_PREFIX,
  ASSISTANT_TOKEN_TTL_SECONDS,
  assistantActionDigest,
} from '@auto-swe/shared/lib/assistantAction';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import { SERVICE_TOKEN_SCOPES, type ServiceTokenScope } from '@auto-swe/shared/types/api';
import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import { type AssistantAccess, assistantAccess } from '../lib/assistantPolicy.js';
import { MCP_BRIDGE_HEADER } from '../lib/mcp/bridge.js';
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from '../lib/mcpOAuth.js';

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
       *  scoped so it can never be replayed as an API bearer (and vice versa).
       *  `nonce`, when given, is carried for a flow that binds the state to the
       *  browser that started it. */
      signOAuthState: (sub: string, purpose: OAuthStatePurpose, nonce?: string) => string;
      verifyOAuthState: (
        token: string,
        purpose: OAuthStatePurpose
      ) => { sub: string; nonce?: string };
      /**
       * Mint the token the in-app assistant acts with for one conversation: the user's identity,
       * bound to that conversation, for {@link ASSISTANT_TOKEN_TTL_SECONDS}. Only `requireAuth`'s
       * assistant path accepts it, and only on routes `assistantPolicy.ts` admits.
       */
      signAssistantToken: (claims: { userId: string; conversationId: string }) => string;
      /** Signature, expiry, audience and shape only — no database read, so not authorization. */
      verifyAssistantTokenClaims: (token: string) => { sub: string; conversationId: string };
    };
  }
  interface FastifyRequest {
    user?: JwtPayload;
    /**
     * Set when the caller is the in-app assistant acting for `user`. Absent on every other request,
     * so a handler can tell an action the person took from one their assistant took.
     */
    assistant?: AssistantCaller;
    /**
     * The digest of this request (`assistantActionDigest`), taken once the body is parsed. Set only
     * on a request that presents an assistant token.
     */
    assistantBodyDigest?: string;
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
    /**
     * Set when the request is an MCP tool call bridged in-process: which client, under which
     * consent, with which effective scopes. Absent on every other request.
     */
    mcpBridge?: { clientId: string; consentId: string; scopes: string[] };
    /**
     * Set, instead of `user`, when the caller authenticated with a service principal's token.
     * A service token never becomes `request.user`: every handler that reads the user is closed
     * to it, and only a route that declares `config.serviceScopes` is reached at all.
     */
    principal?: ServicePrincipalCaller;
  }
  interface FastifyContextConfig {
    /**
     * Opt a route in to MCP tool calls. A bridged call is refused on a route that does not
     * declare this, and on one that declares `read` when the token has no `mcp:read`.
     */
    mcpScope?: 'read' | 'write';
    /**
     * Opt a route in to service principal tokens: the scopes a service token must carry to call
     * it. A route that does not declare this answers a service token with 401
     * `SERVICE_TOKEN_NOT_ALLOWED`, so a new route is closed to machines until someone decides
     * otherwise. A user's token and session ignore it.
     */
    serviceScopes?: readonly ServiceTokenScope[];
  }
}

/**
 * The caller behind a service principal's token, as `requireAuth` loaded it at the start of the
 * request. The allowlists and limits here are for early refusals only; a launch re-reads them
 * under the principal's row lock (`servicePrincipalLaunchGuard`).
 */
export interface ServicePrincipalCaller {
  kind: 'service';
  servicePrincipalId: string;
  name: string;
  teamId: string;
  /** The token's scopes. */
  scopes: ServiceTokenScope[];
  tokenId: string;
  connectionIds: string[];
  templateIds: string[];
}

/** The in-app assistant, as `requireAuth` admitted it. */
export interface AssistantCaller {
  conversationId: string;
  /** What `assistantPolicy.ts` allows on this route: never `never`, which is refused. */
  access: Exclude<AssistantAccess, 'never'>;
  /** The confirmed `AssistantAction` this request spent, on a `confirm` route. */
  actionId?: string;
}

/** Who is calling a route that admits both people and service principals. */
export type RouteCaller =
  | { kind: 'user'; user: JwtPayload }
  | { kind: 'service'; principal: ServicePrincipalCaller };

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

/**
 * The caller of a route that declares `config.serviceScopes`: a person, or a service principal.
 * Use instead of {@link requireUser} on exactly those routes; everywhere else a service token
 * never reaches the handler.
 */
export function requireCaller(request: FastifyRequest): RouteCaller {
  if (request.principal) {
    return { kind: 'service', principal: request.principal };
  }
  return { kind: 'user', user: requireUser(request) };
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
// The assistant's token is a JWT of its own audience behind a prefix, so it is never mistaken for an
// API access token (whose audience it lacks) and `requireAuth` can route it before verifying.
const ASSISTANT_AUDIENCE = 'auto-swe:assistant';
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

/**
 * The `api_tokens` lookup behind a PAT check failed — an outage, a pool
 * timeout, or a relation missing mid-deploy. Like {@link TokenUserLookupError}
 * it says nothing about the token, so the hook rethrows it as a server error
 * rather than answering 401 (and its cause, which is database text, is logged,
 * never sent).
 */
class ApiTokenLookupError extends Error {
  constructor(cause: unknown) {
    super('Could not load this access token', { cause });
    this.name = 'ApiTokenLookupError';
  }
}

/**
 * The fixed 401 message for a bearer token that failed verification. Only the
 * platform's own errors carry text meant for the caller; anything else — a
 * library error, an unexpected throw — gets a fixed message, so a 401 never
 * echoes internal error text.
 */
function bearerRejectionMessage(err: unknown): string {
  if (err instanceof TokenUserRevokedError) {
    return err.message;
  }
  if (err instanceof jwt.TokenExpiredError) {
    return 'Access token expired';
  }
  if (err instanceof jwt.JsonWebTokenError) {
    return 'Invalid access token';
  }
  return 'Invalid token';
}

/** The live user fields an access token's claims are re-checked against. */
export interface TokenUserState {
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

export async function loadTokenUser(
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
  fastify.addHook('onRoute', assertServiceScopesAdmissible);
  fastify.addHook('onRoute', appendAssistantBackstop);
  fastify.addHook('preValidation', checkAssistantGrantOnceParsed);
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

    signAssistantToken({ userId, conversationId }) {
      const signed = jwt.sign({ cid: conversationId }, privateKey, {
        algorithm,
        audience: ASSISTANT_AUDIENCE,
        expiresIn: ASSISTANT_TOKEN_TTL_SECONDS,
        subject: userId,
      });
      return `${ASSISTANT_TOKEN_PREFIX}${signed}`;
    },

    signOAuthState(sub: string, purpose: OAuthStatePurpose, nonce?: string): string {
      return jwt.sign({ ...(nonce ? { nonce } : {}), purpose, sub }, privateKey, {
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

    verifyAssistantTokenClaims(token) {
      if (!token.startsWith(ASSISTANT_TOKEN_PREFIX)) {
        throw new jwt.JsonWebTokenError('not an assistant token');
      }
      const decoded = jwt.verify(token.slice(ASSISTANT_TOKEN_PREFIX.length), publicKey, {
        algorithms: [algorithm],
        audience: ASSISTANT_AUDIENCE,
      }) as { sub?: unknown; cid?: unknown };
      if (
        typeof decoded.sub !== 'string' ||
        !UUID_RE.test(decoded.sub) ||
        typeof decoded.cid !== 'string' ||
        !UUID_RE.test(decoded.cid)
      ) {
        throw new jwt.JsonWebTokenError('malformed assistant token');
      }
      return { conversationId: decoded.cid, sub: decoded.sub };
    },

    verifyOAuthState(token: string, purpose: OAuthStatePurpose): { sub: string; nonce?: string } {
      const decoded = jwt.verify(token, publicKey, {
        algorithms: [algorithm],
        audience: OAUTH_STATE_AUDIENCE,
      }) as { sub: string; purpose?: string; nonce?: unknown };
      if (decoded.purpose !== purpose) {
        throw new Error('OAuth state was minted for a different flow');
      }
      return {
        sub: decoded.sub,
        ...(typeof decoded.nonce === 'string' ? { nonce: decoded.nonce } : {}),
      };
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
 * prefix bypasses JWT verification and hashes through ApiToken
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

const SCOPE_SET: ReadonlySet<string> = new Set(SERVICE_TOKEN_SCOPES);

/**
 * Resolve a `ats_*` token. A personal access token becomes a synthesized `JwtPayload`, so
 * downstream RBAC behaves identically to JWT auth; a service principal's token becomes a
 * {@link ServicePrincipalCaller}, never a user. Throws {@link PatAuthError} with a typed code on
 * rejection; the caller maps it to a 401 response.
 *
 * A service token is refused when it is revoked or expired (every service token has an expiry),
 * or when its principal is disabled, its team inactive or its team's organization inactive.
 */
async function verifyPatPayload(
  request: FastifyRequest,
  token: string
): Promise<{ user: JwtPayload } | { principal: ServicePrincipalCaller }> {
  const hash = request.server.auth.hashToken(token);
  const pat = await request.server.prisma.apiToken
    .findUnique({
      include: {
        servicePrincipal: {
          select: {
            connectionIds: true,
            disabledAt: true,
            id: true,
            name: true,
            team: { select: { isActive: true, organization: { select: { isActive: true } } } },
            teamId: true,
            templateIds: true,
          },
        },
        user: true,
      },
      where: { tokenHash: hash },
    })
    .catch((err: unknown) => {
      throw new ApiTokenLookupError(err);
    });
  if (!pat || pat.revokedAt) {
    throw new PatAuthError('TOKEN_INVALID', 'Invalid or revoked access token');
  }
  const sp = pat.servicePrincipal;
  if (pat.user ? !pat.user.isActive : !sp || sp.disabledAt || !sp.team.isActive) {
    throw new PatAuthError('TOKEN_INVALID', 'Invalid or revoked access token');
  }
  if (sp && !sp.team.organization.isActive) {
    throw new PatAuthError('TOKEN_INVALID', 'Invalid or revoked access token');
  }
  // A service token without an expiry cannot be minted; one that somehow has none is refused
  // rather than treated as eternal.
  if ((pat.expiresAt && pat.expiresAt < new Date()) || (sp && !pat.expiresAt)) {
    throw new PatAuthError('TOKEN_EXPIRED', 'Access token expired');
  }
  // Fire-and-forget `lastUsedAt` update so a slow write can't add latency.
  request.server.prisma.apiToken
    .update({ data: { lastUsedAt: new Date() }, where: { id: pat.id } })
    .catch(() => {});
  if (sp) {
    return {
      principal: {
        connectionIds: sp.connectionIds,
        kind: 'service',
        name: sp.name,
        // Only the scopes this build knows; an unknown stored value grants nothing.
        scopes: pat.scopes.filter((s): s is ServiceTokenScope => SCOPE_SET.has(s)),
        servicePrincipalId: sp.id,
        teamId: sp.teamId,
        templateIds: sp.templateIds,
        tokenId: pat.id,
      },
    };
  }
  if (!pat.user) {
    throw new PatAuthError('TOKEN_INVALID', 'Invalid or revoked access token');
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    user: {
      exp: now + 60,
      iat: now,
      role: pat.user.role,
      ...(pat.user.slackId ? { slackId: pat.user.slackId } : {}),
      sub: pat.user.id,
    },
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
    // Every assistant call comes from the worker's address, so an IP bucket would make every
    // user's assistant share one limit.
    if (token.startsWith(ASSISTANT_TOKEN_PREFIX)) {
      try {
        return `user:${request.server.auth.verifyAssistantTokenClaims(token).sub}`;
      } catch {
        return ipRateLimitKey(request);
      }
    }
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

type BridgeOutcome = { payload: JwtPayload } | { status: 401 | 403; code: string; message: string };

const MCP_ROLES = ['ADMIN', 'LEAD', 'ENGINEER'];

/**
 * Authenticate an MCP tool call that the bridge made in-process (`lib/mcp/bridge.ts`).
 *
 * Reached only when the request carries the bridge header, in whatever form, and from there it
 * never falls through to the PAT, API-JWT or session paths: a call that claims to be bridged is
 * either a good bridged call or refused. In order:
 *
 * 1. the header must be exactly this process's per-boot secret (else 403);
 * 2. the route must declare `config.mcpScope` (else 403);
 * 3. the credential must be an `Authorization: Bearer` MCP access token, not a PAT (else 401);
 * 4. the shared MCP verifier must accept it, which re-reads consent, client and user (else 401);
 * 5. its effective scopes must cover the route's `mcpScope` (else 403 `INSUFFICIENT_SCOPE`).
 *
 * The caller is the verified token's user, with their current role.
 */
async function authenticateBridgedCall(
  request: FastifyRequest,
  headerValue: unknown
): Promise<BridgeOutcome> {
  const bridge = request.server.mcpBridge;
  if (!bridge?.accepts(headerValue)) {
    return { code: 'FORBIDDEN', message: 'Invalid bridge credentials', status: 403 };
  }
  const mcpScope = request.routeOptions.config.mcpScope;
  if (mcpScope !== 'read' && mcpScope !== 'write') {
    return { code: 'FORBIDDEN', message: 'This route is not available to MCP', status: 403 };
  }
  const authHeader = request.headers.authorization;
  const token =
    typeof authHeader === 'string' ? authHeader.match(/^Bearer (\S+)$/)?.[1] : undefined;
  if (!token || token.startsWith(PAT_PREFIX)) {
    return { code: 'TOKEN_INVALID', message: 'Invalid token', status: 401 };
  }
  const authInfo = await bridge.verify(token);
  const { userId, role, consentId } = authInfo?.extra ?? {};
  if (
    !authInfo ||
    typeof userId !== 'string' ||
    typeof consentId !== 'string' ||
    typeof role !== 'string' ||
    !MCP_ROLES.includes(role)
  ) {
    return { code: 'TOKEN_INVALID', message: 'Invalid token', status: 401 };
  }
  const needed = mcpScope === 'write' ? MCP_SCOPE_WRITE : MCP_SCOPE_READ;
  if (!authInfo.scopes.includes(needed)) {
    return {
      code: 'INSUFFICIENT_SCOPE',
      message: `This call needs the ${needed} scope`,
      status: 403,
    };
  }
  request.mcpBridge = { clientId: authInfo.clientId, consentId, scopes: authInfo.scopes };
  const now = Math.floor(Date.now() / 1000);
  return {
    payload: {
      exp: authInfo.expiresAt ?? now + 60,
      iat: now,
      role: role as Role,
      sub: userId,
    },
  };
}

/**
 * Whether a route guarded by these options may admit a service principal at all. A principal
 * holds no role, so only a route whose bar is the lowest platform role (or none) and that asks
 * for no team or organization role can opt in.
 */
export function serviceAdmissible(options: RBACOptions): boolean {
  return (
    (!options.requiredRole || options.requiredRole === 'ENGINEER') &&
    !options.requiredTeamRole &&
    !options.requiredOrgRole
  );
}

/** The options a `requireAuth` hook was built with, so route registration can read them. */
const RBAC_OPTIONS = Symbol('requireAuth options');

/**
 * Refuse, at registration, a route that opts in to service tokens behind a role a principal
 * cannot hold. Without this the route would register and answer every service call with 403,
 * which reads as a working opt-in in review.
 */
export function assertServiceScopesAdmissible(routeOptions: {
  url?: string;
  config?: { serviceScopes?: readonly string[] };
  onRequest?: unknown;
}): void {
  if (!routeOptions.config?.serviceScopes?.length) {
    return;
  }
  const hooks = Array.isArray(routeOptions.onRequest)
    ? routeOptions.onRequest
    : routeOptions.onRequest
      ? [routeOptions.onRequest]
      : [];
  for (const hook of hooks) {
    const options = (hook as { [RBAC_OPTIONS]?: RBACOptions })[RBAC_OPTIONS];
    if (options && !serviceAdmissible(options)) {
      throw new Error(
        `Route ${routeOptions.url ?? '?'} declares serviceScopes behind a role a service principal cannot hold`
      );
    }
  }
}

/**
 * Admit a service principal's token to this route, or refuse it. Secure by default: a route that
 * declares no `config.serviceScopes` answers 401 `SERVICE_TOKEN_NOT_ALLOWED`, whatever the token
 * carries — so a new route is closed to machines until it opts in. A route that does declare them
 * needs every one on the token (else 403 `INSUFFICIENT_SCOPE`). A platform role above ENGINEER,
 * or any team or organization role, refuses a principal outright: it holds no role to check
 * (and `assertServiceScopesAdmissible` refuses such a route at registration).
 *
 * The principal is set on `request.principal` and `request.user` stays unset, so a handler that
 * reads the user cannot mistake a machine for a person.
 */
async function admitServicePrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  principal: ServicePrincipalCaller,
  options: RBACOptions
) {
  const required = request.routeOptions.config?.serviceScopes;
  if (!required || required.length === 0) {
    return reply.status(401).send({
      error: {
        code: 'SERVICE_TOKEN_NOT_ALLOWED',
        message: 'This route does not accept service principal tokens',
      },
    });
  }
  const missing = required.filter((scope) => !principal.scopes.includes(scope));
  if (missing.length > 0) {
    return reply.status(403).send({
      error: {
        code: 'INSUFFICIENT_SCOPE',
        message: `This call needs the ${missing.join(', ')} scope`,
      },
    });
  }
  if (!serviceAdmissible(options)) {
    return reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'This route needs a role a service principal cannot hold',
      },
    });
  }
  request.principal = principal;
  // A principal's runs use the platform credential, so the gate has nothing of its own to judge;
  // it is resolved anyway so a handler shared with people reads the same value it would for them.
  const gate = await resolveRepoAccessGateOrLastKnown();
  request.repoAccessGate = gate ?? { mode: 'off', staleAfterHours: 0 };
}

type AssistantRefusal = { status: 400 | 401 | 403 | 503; code: string; message: string };

/**
 * Authenticate the in-app assistant, acting for the user its token names. In order:
 *
 * 1. the token's signature, audience, expiry and shape (else 401);
 * 2. its user is active, and the payload carries the user's current role (else 401);
 * 2a. its conversation is still open and is that user's (else 401), so closing a conversation
 *    revokes every token minted for it;
 * 3. `assistant.enabled` is on (else 403 `ASSISTANT_DISABLED`; 503 if it cannot be read, so the
 *    switch fails closed);
 * 4. `assistantPolicy.ts` admits this route (else 403 `ASSISTANT_NOT_ALLOWED`).
 *
 * Then the route's own role checks run on the user as for any other credential. A `confirm` route
 * also needs the user's confirmation of this exact request, which can only be checked once the body
 * is parsed: here if `requireAuth` runs that late, else in {@link checkAssistantGrantOnceParsed}.
 */
async function admitAssistant(
  request: FastifyRequest,
  token: string
): Promise<{ payload: JwtPayload } | AssistantRefusal> {
  let claims: { sub: string; conversationId: string };
  try {
    claims = request.server.auth.verifyAssistantTokenClaims(token);
  } catch (err: unknown) {
    return { code: 'TOKEN_INVALID', message: bearerRejectionMessage(err), status: 401 };
  }
  const user = await loadTokenUser(request.server.prisma, claims.sub).catch((err: unknown) => {
    throw new TokenUserLookupError(err);
  });
  if (!user?.isActive) {
    return { code: 'TOKEN_INVALID', message: new TokenUserRevokedError().message, status: 401 };
  }
  const conversation = await request.server.prisma.assistantConversation
    .findFirst({
      select: { id: true },
      where: { closedAt: null, id: claims.conversationId, userId: claims.sub },
    })
    .catch((err: unknown) => {
      throw new TokenUserLookupError(err);
    });
  if (!conversation) {
    return {
      code: 'TOKEN_INVALID',
      message: 'The conversation this assistant token was issued for is closed',
      status: 401,
    };
  }
  let enabled: boolean;
  try {
    enabled = await resolveSetting('assistant.enabled');
  } catch (err: unknown) {
    request.log.error({ err }, 'assistant.enabled could not be read; refusing the assistant');
    return { code: 'ASSISTANT_UNAVAILABLE', message: 'The assistant is unavailable', status: 503 };
  }
  if (!enabled) {
    return {
      code: 'ASSISTANT_DISABLED',
      message: 'The in-app assistant is turned off',
      status: 403,
    };
  }
  const access = assistantAccess(request.method, request.routeOptions.url);
  if (access === 'never') {
    return {
      code: 'ASSISTANT_NOT_ALLOWED',
      message: 'The assistant may not call this route',
      status: 403,
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    exp: now + 60,
    iat: now,
    role: user.role,
    ...(user.slackId ? { slackId: user.slackId } : {}),
    sub: claims.sub,
  };
  // `requireAuth` can run twice on one request (a plugin-wide hook and the route's own). The first
  // admission stands, so a confirmation it already spent is not looked for again.
  request.assistant ??= { access, conversationId: claims.conversationId };
  if (
    request.assistant.access === 'confirm' &&
    request.assistantBodyDigest !== undefined &&
    !request.assistant.actionId
  ) {
    const refusal = await spendConfirmation(request, request.assistant, payload.sub);
    if (refusal) {
      return refusal;
    }
  }
  return { payload };
}

/**
 * The last `preHandler` on every route: an assistant admitted to a `confirm` route must have spent a
 * confirmation by now, whichever hook admitted it. The spend itself happens earlier
 * ({@link checkAssistantGrantOnceParsed}, or `admitAssistant` when `requireAuth` runs after parsing);
 * this guarantees no handler runs an unconfirmed write if that wiring is ever changed.
 */
async function refuseUnspentAssistantWrite(request: FastifyRequest, reply: FastifyReply) {
  if (request.assistant?.access === 'confirm' && !request.assistant.actionId) {
    return reply.status(403).send({
      error: {
        code: 'ASSISTANT_CONFIRMATION_REQUIRED',
        message: "This change needs the user's confirmation first",
      },
    });
  }
}

/** Append {@link refuseUnspentAssistantWrite} after a route's own `preHandler`s. */
export function appendAssistantBackstop(routeOptions: { preHandler?: unknown }): void {
  const own = routeOptions.preHandler;
  routeOptions.preHandler = [
    ...(Array.isArray(own) ? own : own ? [own] : []),
    refuseUnspentAssistantWrite,
  ];
}

/** Never equal to a digest, so a body that cannot be canonicalized matches no confirmation. */
const UNREADABLE_BODY = 'unreadable';

/**
 * Global `preValidation` hook: the first point at which the body is parsed and not yet rewritten by
 * the route's schema. Records the request's digest for any request carrying an assistant token, and
 * spends the confirmation when `requireAuth` has already admitted the assistant to a `confirm` route.
 */
async function checkAssistantGrantOnceParsed(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(`Bearer ${ASSISTANT_TOKEN_PREFIX}`)) {
    return;
  }
  try {
    request.assistantBodyDigest = assistantActionDigest({
      body: request.body,
      method: request.method,
      url: request.url,
    });
  } catch {
    request.assistantBodyDigest = UNREADABLE_BODY;
  }
  const assistant = request.assistant;
  if (assistant?.access !== 'confirm' || assistant.actionId || !request.user) {
    return;
  }
  const refusal = await spendConfirmation(request, assistant, request.user.sub);
  if (refusal) {
    return reply
      .status(refusal.status)
      .send({ error: { code: refusal.code, message: refusal.message } });
  }
}

/**
 * Spend the confirmed action named by the `x-assistant-action` header on this request. The row must
 * be the user's, from this conversation, confirmed and unexpired; it is marked `EXECUTED` in the same
 * statement that checks that, so two requests cannot both spend it. A request whose digest differs
 * from the confirmed one still spends it and is refused: a confirmation authorizes one attempt.
 */
async function spendConfirmation(
  request: FastifyRequest,
  assistant: AssistantCaller,
  userId: string
): Promise<AssistantRefusal | null> {
  const actionId = request.headers[ASSISTANT_ACTION_HEADER];
  if (typeof actionId !== 'string' || !UUID_RE.test(actionId)) {
    return {
      code: 'ASSISTANT_CONFIRMATION_REQUIRED',
      message: "This change needs the user's confirmation first",
      status: 403,
    };
  }
  const now = new Date();
  const prisma = request.server.prisma;
  const spent = await prisma.assistantAction.updateMany({
    data: { executedAt: now, status: 'EXECUTED' },
    where: {
      conversationId: assistant.conversationId,
      expiresAt: { gt: now },
      id: actionId,
      status: 'CONFIRMED',
      userId,
    },
  });
  if (spent.count !== 1) {
    return {
      code: 'ASSISTANT_CONFIRMATION_INVALID',
      message: 'No confirmed, unexpired action matches this request',
      status: 403,
    };
  }
  const row = await prisma.assistantAction.findUnique({
    select: { digest: true },
    where: { id: actionId },
  });
  if (row?.digest !== request.assistantBodyDigest) {
    return {
      code: 'ASSISTANT_CONFIRMATION_MISMATCH',
      message: 'This request differs from the change the user confirmed',
      status: 403,
    };
  }
  assistant.actionId = actionId;
  return null;
}

export function requireAuth(options: RBACOptions = {}) {
  const hook = async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    let payload: JwtPayload | null = null;

    // Path 0: an MCP tool call made in-process by the bridge. Checked first, and by presence of
    // the header rather than by its value, so no malformed or wrong value can fall through to
    // the paths below.
    const bridgeHeader = request.headers[MCP_BRIDGE_HEADER];
    if (bridgeHeader !== undefined) {
      const outcome = await authenticateBridgedCall(request, bridgeHeader);
      if ('status' in outcome) {
        return reply
          .status(outcome.status)
          .send({ error: { code: outcome.code, message: outcome.message } });
      }
      payload = outcome.payload;
    }
    // Path 1: Authorization: Bearer <assistant token, PAT or JWT>
    else if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (token.startsWith(ASSISTANT_TOKEN_PREFIX)) {
        const outcome = await admitAssistant(request, token);
        if ('status' in outcome) {
          return reply
            .status(outcome.status)
            .send({ error: { code: outcome.code, message: outcome.message } });
        }
        payload = outcome.payload;
      } else {
        try {
          if (token.startsWith(PAT_PREFIX)) {
            const resolved = await verifyPatPayload(request, token);
            if ('principal' in resolved) {
              return admitServicePrincipal(request, reply, resolved.principal, options);
            }
            payload = resolved.user;
          } else {
            payload = await request.server.auth.verifyAccessToken(token);
          }
        } catch (err: unknown) {
          if (err instanceof PatAuthError) {
            return reply.status(401).send({ error: { code: err.code, message: err.message } });
          }
          // A failed user or token lookup is an outage, not a verdict on the
          // caller, and its message is internal: surface it as a server error,
          // not a 401 a client would treat as "sign in again".
          if (err instanceof TokenUserLookupError || err instanceof ApiTokenLookupError) {
            throw err;
          }
          if (!(err instanceof jwt.JsonWebTokenError || err instanceof TokenUserRevokedError)) {
            request.log.warn({ err }, 'bearer token rejected by an unexpected error');
          }
          return reply.status(401).send({
            error: { code: 'TOKEN_INVALID', message: bearerRejectionMessage(err) },
          });
        }
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
  return Object.assign(hook, { [RBAC_OPTIONS]: options });
}
