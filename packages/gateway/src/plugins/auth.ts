import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';

// ── JWT Configuration ──

export interface JwtPayload {
  sub: string;              // User UUID
  role: 'ADMIN' | 'LEAD' | 'ENGINEER';
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
  LEAD: 2,
  ENGINEER: 1,
};

function hasRole(userRole: string, requiredRole: string): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[requiredRole] ?? 0);
}

const ACCESS_TOKEN_TTL = '1h';
const REFRESH_TOKEN_BYTES = 48;

function getPrivateKey(): string {
  const keyPath = process.env.JWT_PRIVATE_KEY_PATH;
  if (keyPath) {
    return fs.readFileSync(keyPath, 'utf-8');
  }
  // Fallback for development: use a shared secret (HS256)
  return process.env.JWT_SECRET ?? 'dev-secret-change-me';
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

    generateRefreshToken(): string {
      return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    },

    hashToken(token: string): string {
      return crypto.createHash('sha256').update(token).digest('hex');
    },
  });
};

export { authPlugin, hasRole, ROLE_HIERARCHY };
export default fp(authPlugin, { fastify: '5.x', name: 'auth' });

// ── RBAC Hook Factory ──

export interface RBACOptions {
  requiredRole?: string;       // Platform role check
  requiredTeamRole?: string;   // Team-scoped role check (resolves via repo/team context)
}

/**
 * Creates a Fastify onRequest hook that enforces JWT authentication
 * and optional role-based access control.
 */
export function requireAuth(options: RBACOptions = {}) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' },
      });
    }

    const token = authHeader.slice(7);
    try {
      const payload = (request.server as any).auth.verifyAccessToken(token);
      request.user = payload;
    } catch (err: any) {
      return reply.status(401).send({
        error: { code: 'TOKEN_INVALID', message: err.message ?? 'Invalid token' },
      });
    }

    // Platform role check
    if (options.requiredRole && !hasRole(request.user!.role, options.requiredRole)) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: `Requires ${options.requiredRole} role` },
      });
    }

    // Team role check (if specified, resolved per-route via team context)
    if (options.requiredTeamRole) {
      // Platform ADMIN bypasses team checks
      if (request.user!.role !== 'ADMIN') {
        // Team context must be resolved by the route handler
        // This sets the expectation; route handlers check request.teamRole
        (request as any)._requiredTeamRole = options.requiredTeamRole;
      }
    }
  };
}
