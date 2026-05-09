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
  role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']).optional(),
  slackId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
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
        select: {
          id: true,
          email: true,
          role: true,
          slackId: true,
          isActive: true,
          createdAt: true,
          memberships: {
            select: { team: { select: { id: true, name: true, slug: true } }, role: true },
          },
        },
        orderBy: { email: 'asc' },
      });
      return { data: users };
    }
  );

  // POST /api/v1/users — Create user (ADMIN only)
  app.post(
    '/',
    {
      schema: { body: CreateUserSchema },
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
    },
    async (request, reply) => {
      const { email, password, role, slackId } = request.body;

      const existing = await fastify.prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply.status(409).send({
          error: { code: 'USER_EXISTS', message: 'User with this email already exists' },
        });
      }

      const plainPassword = password ?? crypto.randomBytes(16).toString('base64url');
      const passwordHash = await bcrypt.hash(plainPassword, 12);

      const user = await fastify.prisma.user.create({
        data: { email, passwordHash, role, slackId },
        select: {
          id: true,
          email: true,
          role: true,
          slackId: true,
          isActive: true,
          createdAt: true,
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

  // PATCH /api/v1/users/:id — Update user (ADMIN only)
  app.patch(
    '/:id',
    {
      schema: { params: UserParamsSchema, body: UpdateUserSchema },
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
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

      const updated = await fastify.prisma.user.update({
        where: { id: request.params.id },
        data: request.body,
        select: { id: true, email: true, role: true, slackId: true, isActive: true },
      });

      return { data: updated };
    }
  );
};
