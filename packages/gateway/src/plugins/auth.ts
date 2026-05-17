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
  // Fallback for development: same shared secret (HS256)
  return process.env.JWT_SECRET ?? 'dev-secret-change-me';
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
        expiresIn: ACCESS_TOKEN_TTL,
      });
    },

    verifyAccessToken(token: string): JwtPayload {
      return jwt.verify(token, publicKey, {
        algorithms: [algorithm],
      }) as JwtPayload;
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

/** Resolve a better-auth browser session cookie into a synthesized JwtPayload.
 *  Returns null when no session is present so the caller can fall through to
 *  the unauthorized response. Throws only on User lookup failures (which the
 *  caller surfaces as 403). */
async function verifyBetterAuthSession(request: FastifyRequest): Promise<JwtPayload | null> {
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
  if (!session) return null;
  const user = await request.server.prisma.user.findUnique({
    where: { id: session.user.id },
  });
  if (!user?.isActive) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    exp: now + 60,
    iat: now,
    role: user.role,
    ...(user.slackId ? { slackId: user.slackId } : {}),
    sub: user.id,
  };
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
      if (payload.role === 'ADMIN') return;

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
