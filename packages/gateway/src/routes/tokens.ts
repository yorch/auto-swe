import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Phase-8 personal access tokens.
 *
 * Tokens are `ats_<base64url-32B>` strings. We never store the plaintext;
 * the sha-256 hash + a non-secret 12-char `prefix` (`ats_` + 8 chars) are
 * persisted so the admin UI can disambiguate without re-issuing.
 *
 * Lifecycle:
 *   POST   /api/v1/auth/tokens         — issue (returns plaintext exactly once)
 *   GET    /api/v1/auth/tokens         — list own (no plaintext)
 *   DELETE /api/v1/auth/tokens/:id     — revoke
 */

const PAT_BYTES = 32;
const PAT_PREFIX = 'ats_';

const CreateTokenBody = z.object({
  /** Days until expiry. Omit for non-expiring (max 365). */
  expiresInDays: z.number().int().min(1).max(365).optional(),
  name: z.string().min(1).max(120),
});

const TokenIdParam = z.object({ id: z.string().uuid() });

function generateToken(): string {
  return `${PAT_PREFIX}${crypto.randomBytes(PAT_BYTES).toString('base64url')}`;
}

export const tokenRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── List own tokens ──
  app.get('/', { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) }, async (request) => {
    const user = requireUser(request);
    const rows = await fastify.prisma.personalAccessToken.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        expiresAt: true,
        id: true,
        lastUsedAt: true,
        name: true,
        prefix: true,
        revokedAt: true,
      },
      where: { userId: user.sub },
    });
    return { data: rows };
  });

  // ── Issue a new token (plaintext returned exactly once) ──
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: CreateTokenBody },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { name, expiresInDays } = request.body;
      const plaintext = generateToken();
      const tokenHash = fastify.auth.hashToken(plaintext);
      const prefix = plaintext.slice(0, 12); // `ats_` + 8 chars
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : null;
      const created = await fastify.prisma.personalAccessToken.create({
        data: {
          expiresAt,
          name,
          prefix,
          tokenHash,
          userId: user.sub,
        },
      });
      // Plaintext appears in this response and NEVER again. Clients must
      // capture it now or revoke + re-issue.
      return reply.status(201).send({
        data: {
          createdAt: created.createdAt,
          expiresAt: created.expiresAt,
          id: created.id,
          name: created.name,
          prefix: created.prefix,
          token: plaintext,
        },
      });
    }
  );

  // ── Revoke ──
  app.delete(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TokenIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.personalAccessToken.findUnique({
        where: { id: request.params.id },
      });
      if (!existing || existing.userId !== user.sub) {
        // Hide the row's existence from non-owners. Platform admins can
        // already see all tokens via list+select in a future admin UI; we
        // don't surface them here to keep the route boundary tight.
        return reply.status(404).send({
          error: { code: 'TOKEN_NOT_FOUND', message: 'Token not found' },
        });
      }
      if (existing.revokedAt) {
        return { data: { id: existing.id, revokedAt: existing.revokedAt } };
      }
      const updated = await fastify.prisma.personalAccessToken.update({
        data: { revokedAt: new Date() },
        where: { id: existing.id },
      });
      return { data: { id: updated.id, revokedAt: updated.revokedAt } };
    }
  );
};
