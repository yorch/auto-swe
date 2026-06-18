import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  BundleDependencyError,
  BundleIntegrityError,
  exportBundle,
  installBundle,
} from '../lib/bundleService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Admin bundle distribution API (P4/WS1+WS2). Export a tagged set of GLOBAL
 * library content to a portable bundle, and install a bundle as a managed base
 * layer. GLOBAL scope → platform ADMIN only.
 */
const ExportBody = z.object({
  name: z.string().min(1).max(200),
  /** Optional provenance/origin selector (e.g. 'swe-starter'); omit to export all GLOBAL content. */
  origin: z.string().max(200).optional(),
  version: z.string().min(1).max(50),
});

const InstallBody = z.object({ bundle: z.unknown() });

export const bundleRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  app.post(
    '/bundles/export',
    { onRequest: adminOnly, schema: { body: ExportBody } },
    async (request) => {
      const manifest = await exportBundle(fastify.prisma, request.body);
      return { data: manifest };
    }
  );

  app.post(
    '/bundles/install',
    { onRequest: adminOnly, schema: { body: InstallBody } },
    async (request, reply) => {
      const actor = requireUser(request);
      try {
        const result = await installBundle(fastify.prisma, request.body.bundle);
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { counts: result.counts },
          entityId: 'bundle',
          entityType: 'Bundle',
        });
        return reply.send({ data: result });
      } catch (err) {
        if (err instanceof BundleIntegrityError || err instanceof BundleDependencyError) {
          return reply
            .status(400)
            .send({ error: { code: 'INVALID_BUNDLE', message: err.message } });
        }
        if (err instanceof z.ZodError) {
          return reply.status(400).send({
            error: { code: 'INVALID_BUNDLE', message: 'bundle failed schema validation' },
          });
        }
        throw err;
      }
    }
  );
};
