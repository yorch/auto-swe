import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const MAX_ACTIVE_REFRESH_TOKENS = 5;
const REFRESH_TOKEN_TTL_DAYS = 7;
const REFRESH_TOKEN_MAX_AGE_SECONDS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;
const REFRESH_COOKIE_NAME = 'refreshToken';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /api/v1/auth/login
  app.post(
    '/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: { body: LoginSchema },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const user = await fastify.prisma.user.findUnique({ where: { email } });
      if (!user || !user.isActive) {
        return reply.status(401).send({
          error: { code: 'AUTH_FAILED', message: 'Invalid email or password' },
        });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return reply.status(401).send({
          error: { code: 'AUTH_FAILED', message: 'Invalid email or password' },
        });
      }

      // Issue tokens
      const accessToken = fastify.auth.signAccessToken({
        role: user.role,
        slackId: user.slackId ?? undefined,
        sub: user.id,
      });

      const refreshToken = fastify.auth.generateRefreshToken();
      const tokenHash = fastify.auth.hashToken(refreshToken);
      const family = crypto.randomUUID();

      // Store hashed refresh token
      await fastify.prisma.refreshToken.create({
        data: {
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
          family,
          tokenHash,
          userId: user.id,
        },
      });

      // Enforce max active refresh tokens per user
      const activeTokens = await fastify.prisma.refreshToken.findMany({
        orderBy: { createdAt: 'desc' },
        where: { revokedAt: null, userId: user.id },
      });
      if (activeTokens.length > MAX_ACTIVE_REFRESH_TOKENS) {
        const toRevoke = activeTokens.slice(MAX_ACTIVE_REFRESH_TOKENS);
        await fastify.prisma.refreshToken.updateMany({
          data: { revokedAt: new Date() },
          where: { id: { in: toRevoke.map((t) => t.id) } },
        });
      }

      reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
        path: '/api/v1/auth/refresh',
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
      });

      return { data: { accessToken, expiresIn: 3600 } };
    }
  );

  // POST /api/v1/auth/refresh
  app.post(
    '/refresh',
    {
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const refreshToken = request.cookies[REFRESH_COOKIE_NAME];
      if (!refreshToken) {
        return reply.status(401).send({
          error: { code: 'TOKEN_MISSING', message: 'No refresh token provided' },
        });
      }
      const tokenHash = fastify.auth.hashToken(refreshToken);

      const stored = await fastify.prisma.refreshToken.findUnique({
        include: { user: true },
        where: { tokenHash },
      });

      if (!stored) {
        return reply.status(401).send({
          error: { code: 'TOKEN_INVALID', message: 'Invalid refresh token' },
        });
      }

      // Token reuse detection: if already revoked, revoke the entire family
      if (stored.revokedAt) {
        await fastify.prisma.refreshToken.updateMany({
          data: { revokedAt: new Date() },
          where: { family: stored.family },
        });
        return reply.status(401).send({
          error: { code: 'TOKEN_REUSE_DETECTED', message: 'Token reuse detected — family revoked' },
        });
      }

      // Check expiry
      if (stored.expiresAt < new Date()) {
        return reply.status(401).send({
          error: { code: 'TOKEN_EXPIRED', message: 'Refresh token expired' },
        });
      }

      // Revoke old token and issue the new one atomically.
      // Without a transaction, two concurrent requests with the same refresh token
      // could both pass the revocation check and both create new tokens, breaking
      // the family-rotation invariant.
      const newRefreshToken = fastify.auth.generateRefreshToken();
      const newTokenHash = fastify.auth.hashToken(newRefreshToken);
      const newExpiry = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

      await fastify.prisma.$transaction([
        fastify.prisma.refreshToken.update({
          data: { revokedAt: new Date() },
          where: { id: stored.id },
        }),
        fastify.prisma.refreshToken.create({
          data: {
            expiresAt: newExpiry,
            family: stored.family,
            tokenHash: newTokenHash,
            userId: stored.userId,
          },
        }),
      ]);

      const accessToken = fastify.auth.signAccessToken({
        role: stored.user.role,
        slackId: stored.user.slackId ?? undefined,
        sub: stored.user.id,
      });

      reply.setCookie(REFRESH_COOKIE_NAME, newRefreshToken, {
        httpOnly: true,
        maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
        path: '/api/v1/auth/refresh',
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
      });

      return { data: { accessToken, expiresIn: 3600 } };
    }
  );
};
