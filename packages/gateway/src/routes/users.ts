import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).optional(), // Auto-generated if not provided
  role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']).default('ENGINEER'),
  slackId: z.string().optional(),
});

const UserParamsSchema = z.object({ id: z.string().uuid() });

const UpdateUserSchema = z.object({
  email: z.string().email().optional(),
  isActive: z.boolean().optional(),
  role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']).optional(),
  slackId: z.string().nullable().optional(),
});

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/users — List users (ADMIN only)
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
    },
    async () => {
      const users = await fastify.prisma.user.findMany({
        orderBy: { email: 'asc' },
        select: {
          createdAt: true,
          email: true,
          id: true,
          isActive: true,
          memberships: {
            select: { role: true, team: { select: { id: true, name: true, slug: true } } },
          },
          role: true,
          slackId: true,
        },
      });
      return { data: users };
    }
  );

  // POST /api/v1/users — Create user (ADMIN only)
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: CreateUserSchema },
    },
    async (request, reply) => {
      const { email, password, role, slackId } = request.body;

      const existing = await fastify.prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply.status(409).send({
          error: { code: 'USER_EXISTS', message: 'User with this email already exists' },
        });
      }

      // slackId must be unique — a collision would make the Slack webhook/slash
      // handlers (which resolve users by slackId) ambiguous.
      if (slackId) {
        const slackTaken = await fastify.prisma.user.findFirst({ where: { slackId } });
        if (slackTaken) {
          return reply.status(409).send({
            error: { code: 'SLACK_ID_TAKEN', message: 'This Slack ID is linked to another user' },
          });
        }
      }

      const plainPassword = password ?? crypto.randomBytes(16).toString('base64url');
      const passwordHash = await bcrypt.hash(plainPassword, 12);

      const user = await fastify.prisma.user.create({
        data: { email, passwordHash, role, slackId },
        select: {
          createdAt: true,
          email: true,
          id: true,
          isActive: true,
          role: true,
          slackId: true,
        },
      });

      return reply.status(201).send({
        data: {
          ...user,
          // Only return the generated password on creation
          ...(password ? {} : { temporaryPassword: plainPassword }),
        },
      });
    }
  );

  // POST /api/v1/users/invite — Admin invites a new user by email.
  // The user lands pre-active (skip the approval queue — admin vouched)
  // and pre-membered to the default team. We immediately fire a magic-link
  // so the invitee can sign in by clicking the email. They never see a
  // password screen.
  app.post(
    '/invite',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: {
        body: z.object({
          email: z.string().email(),
          role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']).default('ENGINEER'),
        }),
      },
    },
    async (request, reply) => {
      const { email, role } = request.body;
      const existing = await fastify.prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply.status(409).send({
          error: { code: 'USER_EXISTS', message: 'User with this email already exists' },
        });
      }

      const user = await fastify.prisma.user.create({
        data: {
          email,
          emailVerified: true, // Admin vouched for this email
          isActive: true, // Admin-invited → skip the approval queue
          role,
        },
        select: { email: true, id: true, isActive: true, role: true },
      });

      // Pre-attach to the default team so the new user sees something on
      // first sign-in. Soft-fails if the team doesn't exist (seed missing).
      const defaultTeam = await fastify.prisma.team.findUnique({
        where: { slug: process.env.DEFAULT_TEAM_SLUG ?? 'default' },
      });
      if (defaultTeam) {
        await fastify.prisma.teamMembership
          .upsert({
            create: { role: 'ENGINEER', teamId: defaultTeam.id, userId: user.id },
            update: {},
            where: { userId_teamId: { teamId: defaultTeam.id, userId: user.id } },
          })
          .catch(() => {
            /* non-fatal */
          });
      }

      // Send a magic-link via better-auth so the invitee can sign in
      // without ever choosing a password. Lazy-load betterAuth to avoid
      // a circular import (routes/users → lib/betterAuth → adapter →
      // PrismaClient already in scope here).
      try {
        const { auth: betterAuth } = await import('../lib/betterAuth.js');
        const clientOrigin =
          process.env.CORS_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:3000';
        await betterAuth.api.signInMagicLink({
          body: { callbackURL: `${clientOrigin}/login?bridge=1`, email },
          // better-auth's typing requires a Headers object even for purely
          // server-side invocations (no real browser headers to forward here).
          headers: new Headers(),
        });
      } catch (err) {
        fastify.log.warn({ err }, 'invite magic-link send failed — user row was created');
      }

      return reply.status(201).send({ data: user });
    }
  );

  // PATCH /api/v1/users/:id — Update user (ADMIN only)
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: UpdateUserSchema, params: UserParamsSchema },
    },
    async (request, reply) => {
      const user = await fastify.prisma.user.findUnique({
        where: { id: request.params.id },
      });
      if (!user) {
        return reply.status(404).send({
          error: { code: 'USER_NOT_FOUND', message: 'User not found' },
        });
      }

      // Guard slackId uniqueness on reassignment (see POST handler note).
      if (request.body.slackId) {
        const slackTaken = await fastify.prisma.user.findFirst({
          where: { id: { not: request.params.id }, slackId: request.body.slackId },
        });
        if (slackTaken) {
          return reply.status(409).send({
            error: { code: 'SLACK_ID_TAKEN', message: 'This Slack ID is linked to another user' },
          });
        }
      }

      const updated = await fastify.prisma.user.update({
        data: request.body,
        select: { email: true, id: true, isActive: true, role: true, slackId: true },
        where: { id: request.params.id },
      });

      return { data: updated };
    }
  );
};
