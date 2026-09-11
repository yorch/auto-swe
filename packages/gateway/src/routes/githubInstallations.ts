/**
 * Managing GitHub App installations.
 *
 * The `GitHubConfig` singleton holds the App's own credentials, which are
 * instance-wide. Where the App is *installed* is not: reaching repositories
 * across several GitHub organizations means several installations, and this is
 * how an operator records them.
 *
 * ADMIN-only, like the other credential-adjacent admin surfaces. An
 * installation id is not a secret, but pointing a repository at the wrong one
 * silently changes which GitHub account answers permission questions about it.
 */
import { Prisma } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth } from '../plugins/auth.js';

/** GitHub installation ids are numeric, but opaque — kept as a string. */
const InstallationIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9]+$/, 'must be a numeric GitHub installation id');

const CreateSchema = z.object({
  accountLogin: z.string().min(1).max(200),
  installationId: InstallationIdSchema,
  isActive: z.boolean().optional().default(true),
});

const UpdateSchema = z.object({
  accountLogin: z.string().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

export const githubInstallationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  // GET /github-installations
  app.get('/github-installations', { onRequest: adminOnly }, async () => {
    const rows = await fastify.prisma.gitHubInstallation.findMany({
      include: { _count: { select: { connections: true } } },
      orderBy: { accountLogin: 'asc' },
    });
    return { data: rows };
  });

  // POST /github-installations
  app.post(
    '/github-installations',
    { onRequest: adminOnly, schema: { body: CreateSchema } },
    async (request, reply) => {
      try {
        const created = await fastify.prisma.gitHubInstallation.create({ data: request.body });
        return reply.status(201).send({ data: created });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return reply.status(409).send({
            error: {
              code: 'INSTALLATION_EXISTS',
              message: `Installation ${request.body.installationId} is already registered`,
            },
          });
        }
        throw err;
      }
    }
  );

  // PATCH /github-installations/:id
  app.patch(
    '/github-installations/:id',
    { onRequest: adminOnly, schema: { body: UpdateSchema, params: IdParams } },
    async (request, reply) => {
      try {
        const updated = await fastify.prisma.gitHubInstallation.update({
          data: request.body,
          where: { id: request.params.id },
        });
        return { data: updated };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          return reply.status(404).send({
            error: { code: 'INSTALLATION_NOT_FOUND', message: 'Installation not found' },
          });
        }
        throw err;
      }
    }
  );

  // DELETE /github-installations/:id
  //
  // Refused while any repository still points at it. `ON DELETE RESTRICT` would
  // enforce this anyway; catching it here turns a foreign-key error into an
  // explanation of which repositories have to be repointed first.
  app.delete(
    '/github-installations/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const inUse = await runUnscoped(
        'an installation spans every team that points a repo at it',
        ['Connection'],
        () =>
          fastify.prisma.connection.findMany({
            select: { organizationName: true, repoName: true },
            take: 10,
            where: { installationId: request.params.id },
          })
      );
      if (inUse.length > 0) {
        return reply.status(409).send({
          error: {
            code: 'INSTALLATION_IN_USE',
            message: `Still used by: ${inUse.map((c) => `${c.organizationName}/${c.repoName}`).join(', ')}`,
          },
        });
      }
      try {
        await fastify.prisma.gitHubInstallation.delete({ where: { id: request.params.id } });
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          return reply.status(404).send({
            error: { code: 'INSTALLATION_NOT_FOUND', message: 'Installation not found' },
          });
        }
        // A repository repointed at this installation between the check above
        // and this delete. `ON DELETE RESTRICT` refuses, which is the right
        // outcome — but without this branch the foreign-key error became a 500,
        // so the one case the pre-check exists to explain showed a generic
        // failure instead.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
          return reply.status(409).send({
            error: {
              code: 'INSTALLATION_IN_USE',
              message:
                'A repository was pointed at this installation while it was being deleted. Repoint it and try again.',
            },
          });
        }
        throw err;
      }
    }
  );
};
