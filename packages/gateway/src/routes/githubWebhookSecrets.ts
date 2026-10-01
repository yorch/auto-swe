/**
 * Managing per-host GitHub webhook secrets.
 *
 * The GitHub integration holds one webhook secret. A GitHub Enterprise Server
 * host that sends its own deliveries has its own, recorded here by host and
 * used to verify only the deliveries that name that host in
 * `X-GitHub-Enterprise-Host` (see `lib/githubWebhookSecret.ts`).
 *
 * ADMIN-only. A secret is write-only: it is encrypted on the way in and the API
 * only ever reports its last four characters.
 */
import { Prisma } from '@auto-swe/shared';
import { hostEntry } from '@auto-swe/shared/config';
import { approvedRepositoryHosts } from '@auto-swe/shared/lib/connectionCredential';
import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

// A pasted trailing newline is the common way to store a secret that can never
// match, so edge whitespace is refused rather than trimmed silently.
const SecretSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => v === v.trim(), 'must not start or end with whitespace');

const CreateSchema = z.object({ host: hostEntry, secret: SecretSchema });
const UpdateSchema = z.object({ secret: SecretSchema });
const IdParams = z.object({ id: z.string().uuid() });

const isRecordNotFound = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';

function present(row: {
  id: string;
  host: string;
  secretLastFour: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    createdAt: row.createdAt,
    host: row.host,
    id: row.id,
    lastFour: row.secretLastFour,
    updatedAt: row.updatedAt,
  };
}

function toColumns(secret: string) {
  const e = encryptSecret(secret);
  return {
    secretAuthTag: e.authTag,
    secretCiphertext: e.ciphertext,
    secretKeyVersion: e.keyVersion,
    secretLastFour: e.lastFour,
    secretNonce: e.nonce,
  };
}

export const githubWebhookSecretRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });
  const notFound = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 404, 'WEBHOOK_SECRET_NOT_FOUND', 'No webhook secret with that id');

  // GET /github-webhook-secrets
  app.get('/github-webhook-secrets', { onRequest: adminOnly }, async () => {
    const rows = await fastify.prisma.gitHubHostWebhookSecret.findMany({
      orderBy: { host: 'asc' },
    });
    return { data: rows.map(present) };
  });

  // POST /github-webhook-secrets
  app.post(
    '/github-webhook-secrets',
    { onRequest: adminOnly, schema: { body: CreateSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const { host, secret } = request.body;
      // A secret for a host the platform never talks to could only ever be
      // matched by a delivery from somewhere nobody approved.
      if (!(await approvedRepositoryHosts()).includes(host)) {
        return sendError(
          reply,
          400,
          'HOST_NOT_APPROVED',
          `${host} is neither a configured GitHub host nor listed in github.repositoryHosts`
        );
      }
      try {
        const created = await fastify.prisma.gitHubHostWebhookSecret.create({
          data: { host, ...toColumns(secret) },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: { host, lastFour: created.secretLastFour },
          entityId: created.id,
          entityType: 'GitHubHostWebhookSecret',
        });
        return reply.status(201).send({ data: present(created) });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'WEBHOOK_SECRET_EXISTS',
            `A webhook secret for ${host} already exists; update it instead`
          );
        }
        throw err;
      }
    }
  );

  // PATCH /github-webhook-secrets/:id — rotate the secret
  app.patch(
    '/github-webhook-secrets/:id',
    { onRequest: adminOnly, schema: { body: UpdateSchema, params: IdParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.gitHubHostWebhookSecret.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return notFound(reply);
      }
      try {
        const updated = await fastify.prisma.gitHubHostWebhookSecret.update({
          data: toColumns(request.body.secret),
          where: { id: existing.id },
        });
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { host: updated.host, lastFour: updated.secretLastFour },
          before: { host: existing.host, lastFour: existing.secretLastFour },
          entityId: existing.id,
          entityType: 'GitHubHostWebhookSecret',
        });
        return { data: present(updated) };
      } catch (err) {
        if (isRecordNotFound(err)) {
          return notFound(reply);
        }
        throw err;
      }
    }
  );

  // DELETE /github-webhook-secrets/:id
  app.delete(
    '/github-webhook-secrets/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const user = requireUser(request);
      try {
        const deleted = await fastify.prisma.gitHubHostWebhookSecret.delete({
          where: { id: request.params.id },
        });
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor: user,
          before: { host: deleted.host, lastFour: deleted.secretLastFour },
          entityId: deleted.id,
          entityType: 'GitHubHostWebhookSecret',
        });
        return reply.status(204).send();
      } catch (err) {
        if (isRecordNotFound(err)) {
          return notFound(reply);
        }
        throw err;
      }
    }
  );
};
