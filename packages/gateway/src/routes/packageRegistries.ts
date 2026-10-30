/**
 * Admin CRUD for `PackageRegistry` — the npm upstreams the worker's registry
 * proxy fronts. Tokens are write-only: sealed on the way in, and the API only
 * ever reports `hasToken`. Platform ADMIN only.
 */
import { Prisma } from '@auto-swe/shared';
import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  PACKAGE_REGISTRY_ACCESS_MODES,
  PACKAGE_REGISTRY_AUTH_KINDS,
  PACKAGE_REGISTRY_ECOSYSTEMS,
} from '@auto-swe/shared/lib/packageRegistry';
import { checkProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const ScopeSchema = z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/i, 'a scope looks like @acme');

/** Writable fields with no defaults: an update must tell "not sent" from "sent as the default". */
const Fields = z.object({
  accessMode: z.enum(PACKAGE_REGISTRY_ACCESS_MODES),
  allowPrivateNetwork: z.boolean(),
  authKind: z.enum(PACKAGE_REGISTRY_AUTH_KINDS),
  ecosystem: z.enum(PACKAGE_REGISTRY_ECOSYSTEMS),
  name: z.string().min(1).max(100),
  npmScopes: z.array(ScopeSchema).max(50),
  teamId: z.string().uuid().nullable(),
  token: z.string().min(1),
  upstreamUrl: z.string().url(),
});

const CreateSchema = z.object({
  accessMode: Fields.shape.accessMode.default('lockfile'),
  allowPrivateNetwork: Fields.shape.allowPrivateNetwork.default(false),
  authKind: Fields.shape.authKind.default('bearer'),
  ecosystem: Fields.shape.ecosystem.default('npm'),
  name: Fields.shape.name,
  npmScopes: Fields.shape.npmScopes.default([]),
  teamId: Fields.shape.teamId.default(null),
  token: Fields.shape.token.optional(),
  upstreamUrl: Fields.shape.upstreamUrl,
});

/**
 * An omitted field is left as stored: `null` clears teamId, omitting token keeps the stored one.
 * Built from `Fields`, never from `CreateSchema.partial()`, because Zod 4 still applies a
 * `.default()` inside an optional, which would turn a `{ token }` rotation into a reset of the
 * team, scopes and auth kind.
 */
const UpdateSchema = Fields.omit({ ecosystem: true }).partial().extend({
  isActive: z.boolean().optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

type Row = Prisma.PackageRegistryGetPayload<object>;

function present(row: Row) {
  return {
    accessMode: row.accessMode,
    allowPrivateNetwork: row.allowPrivateNetwork,
    authKind: row.authKind,
    createdAt: row.createdAt,
    ecosystem: row.ecosystem,
    hasToken: row.tokenCiphertext !== null,
    id: row.id,
    isActive: row.isActive,
    name: row.name,
    npmScopes: row.npmScopes,
    teamId: row.teamId,
    tokenLastFour: row.tokenCiphertext ? row.tokenLastFour : null,
    updatedAt: row.updatedAt,
    upstreamUrl: row.upstreamUrl,
  };
}

/** What an audit entry says about a row — the shape, never the secret. */
function summary(row: Row) {
  const p = present(row);
  return {
    accessMode: p.accessMode,
    authKind: p.authKind,
    ecosystem: p.ecosystem,
    hasToken: p.hasToken,
    name: p.name,
    npmScopes: p.npmScopes,
    teamId: p.teamId,
    upstreamUrl: p.upstreamUrl,
  };
}

function tokenColumns(token: string) {
  const e = encryptSecret(token);
  return {
    tokenAuthTag: e.authTag,
    tokenCiphertext: e.ciphertext,
    tokenKeyVersion: e.keyVersion,
    tokenLastFour: e.lastFour,
    tokenNonce: e.nonce,
  };
}

const GO_HAS_NO_SCOPES = 'A Go registry has no scopes: it serves every module for its team';

/** The Go proxy appends paths to the upstream, so it must be a bare base URL. */
function goUrlProblem(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    return 'A Go registry URL must not carry credentials; put them in the token field';
  }
  if (url.includes('?') || url.includes('#')) {
    return 'A Go registry URL must not carry a query string or a fragment';
  }
  return null;
}

/**
 * Write-time uniqueness, as a 409 problem string or null: among active rows
 * of one ecosystem and team group (null is its own group), at most one default
 * registry and each scope at most once. A Go registry has no scopes, so its
 * only key is the default one. `excludeId` keeps a PATCH from colliding with
 * itself.
 */
async function scopeProblem(
  prisma: { packageRegistry: { findMany: (a: unknown) => Promise<Row[]> } },
  candidate: {
    ecosystem: string;
    isActive: boolean;
    npmScopes: string[];
    teamId: string | null;
  },
  excludeId?: string
): Promise<string | null> {
  if (!candidate.isActive) {
    return null;
  }
  const rows = (await prisma.packageRegistry.findMany({
    where: {
      ecosystem: candidate.ecosystem,
      id: excludeId ? { not: excludeId } : undefined,
      isActive: true,
      teamId: candidate.teamId,
    },
  })) as Row[];
  const candKeys = candidate.npmScopes.length ? candidate.npmScopes : [''];
  for (const row of rows) {
    const rowKeys = row.npmScopes.length ? row.npmScopes : [''];
    const clash = candKeys.find((k) => rowKeys.includes(k));
    if (clash === '' && candidate.ecosystem === 'go') {
      return `an active default Go registry already exists for ${candidate.teamId ? 'this team' : 'all teams'} (${row.name})`;
    }
    if (clash === '') {
      return `an active default registry already exists for ${candidate.teamId ? 'this team' : 'all teams'} (${row.name})`;
    }
    if (clash) {
      return `scope ${clash} is already claimed by ${row.name} for ${candidate.teamId ? 'this team' : 'all teams'}`;
    }
  }
  return null;
}

export const packageRegistryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });
  const notFound = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 404, 'PACKAGE_REGISTRY_NOT_FOUND', 'No package registry with that id');

  // GET /package-registries
  app.get('/package-registries', { onRequest: adminOnly }, async () => {
    // Platform admins list every team's registries — a deliberate cross-team read.
    const rows = await runUnscoped(
      'admin listing of package registries across teams',
      ['PackageRegistry'],
      () =>
        fastify.prisma.packageRegistry.findMany({
          orderBy: [{ teamId: 'asc' }, { name: 'asc' }],
        })
    );
    return { data: rows.map(present) };
  });

  // POST /package-registries
  app.post(
    '/package-registries',
    { onRequest: adminOnly, schema: { body: CreateSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body;
      const upstreamUrl = body.upstreamUrl.replace(/\/+$/, '');
      const safety = checkProbeUrl(upstreamUrl, { allowPrivate: body.allowPrivateNetwork });
      if (!safety.ok) {
        return sendError(reply, 400, 'BASE_URL_REFUSED', safety.reason);
      }
      if (body.ecosystem === 'go') {
        if (body.npmScopes.length) {
          return sendError(reply, 400, 'VALIDATION_ERROR', GO_HAS_NO_SCOPES);
        }
        const urlProblem = goUrlProblem(upstreamUrl);
        if (urlProblem) {
          return sendError(reply, 400, 'BASE_URL_REFUSED', urlProblem);
        }
      }
      const problem = await scopeProblem(fastify.prisma as never, {
        ecosystem: body.ecosystem,
        isActive: true,
        npmScopes: body.npmScopes,
        teamId: body.teamId,
      });
      if (problem) {
        return sendError(reply, 409, 'PACKAGE_REGISTRY_CLASH', problem);
      }
      try {
        const created = await fastify.prisma.packageRegistry.create({
          data: {
            accessMode: body.accessMode,
            allowPrivateNetwork: body.allowPrivateNetwork,
            authKind: body.authKind,
            ecosystem: body.ecosystem,
            name: body.name,
            npmScopes: body.npmScopes,
            teamId: body.teamId,
            upstreamUrl,
            ...(body.token !== undefined && tokenColumns(body.token)),
          },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: summary(created),
          entityId: created.id,
          entityType: 'PackageRegistry',
        });
        return reply.status(201).send({ data: present(created) });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'PACKAGE_REGISTRY_EXISTS',
            `A registry named ${body.name} already exists`
          );
        }
        throw err;
      }
    }
  );

  // PATCH /package-registries/:id
  app.patch(
    '/package-registries/:id',
    { onRequest: adminOnly, schema: { body: UpdateSchema, params: IdParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.packageRegistry.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return notFound(reply);
      }
      const body = request.body;
      const nextUrl = (body.upstreamUrl ?? existing.upstreamUrl).replace(/\/+$/, '');
      const nextPrivate = body.allowPrivateNetwork ?? existing.allowPrivateNetwork;
      const safety = checkProbeUrl(nextUrl, { allowPrivate: nextPrivate });
      if (!safety.ok) {
        return sendError(reply, 400, 'BASE_URL_REFUSED', safety.reason);
      }
      if (existing.ecosystem === 'go') {
        if (body.npmScopes?.length) {
          return sendError(reply, 400, 'VALIDATION_ERROR', GO_HAS_NO_SCOPES);
        }
        const urlProblem = goUrlProblem(nextUrl);
        if (urlProblem) {
          return sendError(reply, 400, 'BASE_URL_REFUSED', urlProblem);
        }
      }
      const problem = await scopeProblem(
        fastify.prisma as never,
        {
          ecosystem: existing.ecosystem,
          isActive: body.isActive ?? existing.isActive,
          npmScopes: body.npmScopes ?? existing.npmScopes,
          teamId: body.teamId === undefined ? existing.teamId : body.teamId,
        },
        existing.id
      );
      if (problem) {
        return sendError(reply, 409, 'PACKAGE_REGISTRY_CLASH', problem);
      }
      const updated = await fastify.prisma.packageRegistry.update({
        data: {
          ...(body.accessMode !== undefined && { accessMode: body.accessMode }),
          ...(body.allowPrivateNetwork !== undefined && {
            allowPrivateNetwork: body.allowPrivateNetwork,
          }),
          ...(body.authKind !== undefined && { authKind: body.authKind }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
          ...(body.name !== undefined && { name: body.name }),
          ...(body.npmScopes !== undefined && { npmScopes: body.npmScopes }),
          ...(body.teamId !== undefined && { teamId: body.teamId }),
          ...(body.token !== undefined && tokenColumns(body.token)),
          upstreamUrl: nextUrl,
        },
        where: { id: existing.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: summary(updated),
        before: summary(existing),
        entityId: existing.id,
        entityType: 'PackageRegistry',
      });
      return { data: present(updated) };
    }
  );

  // DELETE /package-registries/:id
  app.delete(
    '/package-registries/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const user = requireUser(request);
      try {
        const deleted = await fastify.prisma.packageRegistry.delete({
          where: { id: request.params.id },
        });
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor: user,
          before: summary(deleted),
          entityId: deleted.id,
          entityType: 'PackageRegistry',
        });
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          return notFound(reply);
        }
        throw err;
      }
    }
  );
};
