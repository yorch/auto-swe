import type { Prisma } from '@auto-swe/shared';
import {
  BUILTIN_TOOLS,
  hasNoControlChars,
  ToolArchsSchema,
  ToolCatalogEntrySchema,
  ToolLibcSchema,
  ToolMemberSchema,
  ToolStatusSchema,
} from '@auto-swe/shared/lib/toolCatalog';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { isRecordNotFoundError, isUniqueConstraintError } from '../lib/prismaErrors.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * The tool catalog: the allowlist of pinned, checksummed downloads a workspace may install on
 * demand. Any signed-in user may read it — a repository's settings and onboarding pick tools from
 * it — but every write is ADMIN-only, because a row is a binary that runs inside agent workspaces.
 *
 * Built-in rows are seeded from `BUILTIN_TOOLS` at gateway startup and kept in step with code until
 * an admin edits one, which marks it customized. A built-in row cannot be deleted (startup would
 * re-create it): revoke it instead. `key` and `version` are the row's identity and never change.
 */

const Notes = z
  .string()
  .trim()
  .max(2000)
  .refine(hasNoControlChars, 'must not contain control characters')
  .nullable()
  .optional();

// The shared schema is the validation: a malformed entry is rejected, never coerced.
const CreateBody = ToolCatalogEntrySchema.extend({
  notes: Notes,
  status: ToolStatusSchema.optional(),
});

const UpdateBody = z.object({
  archs: ToolArchsSchema.optional(),
  description: ToolCatalogEntrySchema.shape.description,
  libc: ToolLibcSchema.optional(),
  member: ToolMemberSchema.optional(),
  notes: Notes,
  status: ToolStatusSchema.optional(),
});

const ListQuery = z.object({ includeRevoked: booleanQueryParam(false) });

const IdParams = z.object({ id: z.string().uuid() });

type CatalogRow = {
  id: string;
  key: string;
  version: string;
  isBuiltIn: boolean;
  [field: string]: unknown;
};

const builtinToolFor = (key: string, version: string) =>
  BUILTIN_TOOLS.find((t) => t.key === key && t.version === version);

/** A row plus, for a built-in, the values code ships — so a customized row can show what it diverges from. */
function toDto(row: CatalogRow) {
  const builtin = row.isBuiltIn ? builtinToolFor(row.key, row.version) : undefined;
  return {
    ...row,
    builtin: builtin
      ? {
          archs: builtin.archs,
          description: builtin.description ?? null,
          libc: builtin.libc,
          member: builtin.member,
          status: builtin.status,
        }
      : null,
  };
}

const asJson = (value: unknown): Prisma.InputJsonObject =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

export const toolCatalogRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const anyUser = requireAuth();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  const audit = (
    actor: ReturnType<typeof requireUser>,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    row: { id: string },
    extra: { before?: unknown; after?: unknown }
  ) =>
    writeAuditLog(fastify, {
      action,
      actor,
      entityId: row.id,
      entityType: 'ToolCatalogEntry',
      ...extra,
    });

  app.get(
    '/tool-catalog',
    { onRequest: anyUser, schema: { querystring: ListQuery } },
    async (request) => {
      const rows = await fastify.prisma.toolCatalogEntry.findMany({
        orderBy: [{ key: 'asc' }, { version: 'asc' }],
        where: request.query.includeRevoked ? {} : { status: { not: 'REVOKED' } },
      });
      return { data: rows.map(toDto) };
    }
  );

  app.post(
    '/tool-catalog',
    { onRequest: adminOnly, schema: { body: CreateBody } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { archs, notes, ...rest } = request.body;
      let row: CatalogRow;
      try {
        row = await fastify.prisma.toolCatalogEntry.create({
          data: { ...rest, archs: asJson(archs), isBuiltIn: false, isCustomized: false, notes },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'TOOL_EXISTS',
            `'${request.body.key}@${request.body.version}' is already in the catalog`
          );
        }
        throw err;
      }
      await audit(actor, 'CREATE', row, { after: row });
      return reply.status(201).send({ data: toDto(row) });
    }
  );

  app.put(
    '/tool-catalog/:id',
    { onRequest: adminOnly, schema: { body: UpdateBody, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.toolCatalogEntry.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return sendError(reply, 404, 'NOT_FOUND', 'Tool catalog entry not found');
      }
      const { archs, ...rest } = request.body;
      // Any edit to a built-in marks it customized, so startup seeding keeps it.
      const updated = await fastify.prisma.toolCatalogEntry.update({
        data: {
          ...rest,
          ...(archs && { archs: asJson(archs) }),
          ...(existing.isBuiltIn && { isCustomized: true }),
        },
        where: { id: existing.id },
      });
      await audit(actor, 'UPDATE', existing, { after: updated, before: existing });
      return { data: toDto(updated) };
    }
  );

  // Its own audited action rather than a PUT of `status`: revoking is what stops every future
  // install of a tool, so it should read as such in the audit log.
  app.post(
    '/tool-catalog/:id/revoke',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.toolCatalogEntry.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return sendError(reply, 404, 'NOT_FOUND', 'Tool catalog entry not found');
      }
      const updated = await fastify.prisma.toolCatalogEntry.update({
        data: { status: 'REVOKED', ...(existing.isBuiltIn && { isCustomized: true }) },
        where: { id: existing.id },
      });
      await audit(actor, 'UPDATE', existing, { after: updated, before: existing });
      return { data: toDto(updated) };
    }
  );

  app.post(
    '/tool-catalog/:id/reset',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.toolCatalogEntry.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return sendError(reply, 404, 'NOT_FOUND', 'Tool catalog entry not found');
      }
      const builtin = existing.isBuiltIn
        ? builtinToolFor(existing.key, existing.version)
        : undefined;
      if (!builtin) {
        return sendError(
          reply,
          409,
          'NOT_BUILT_IN',
          'Only a tool that ships built-in can be reset to its built-in values'
        );
      }
      // A reset restores what code ships, but never un-revokes: re-enabling a tool is its own
      // decision. A row that keeps REVOKED stays customized, or startup seeding (which follows
      // code for an untouched row) would make it ACTIVE again on the next boot.
      const keepRevoked = existing.status === 'REVOKED';
      // Conditional on the status just read: a revoke that lands between the read and this write
      // must not be overwritten with the code's ACTIVE.
      const { count } = await fastify.prisma.toolCatalogEntry.updateMany({
        data: {
          archs: asJson(builtin.archs),
          description: builtin.description ?? null,
          isCustomized: keepRevoked,
          libc: builtin.libc,
          member: builtin.member,
          ...(keepRevoked ? {} : { status: builtin.status }),
        },
        where: { id: existing.id, status: existing.status },
      });
      const updated =
        count === 1
          ? await fastify.prisma.toolCatalogEntry.findUnique({
              where: { id: existing.id },
            })
          : null;
      if (!updated) {
        return sendError(
          reply,
          409,
          'TOOL_CHANGED',
          'The tool catalog entry changed while it was being reset. Reload it and try again.'
        );
      }
      await audit(actor, 'UPDATE', existing, {
        after: keepRevoked ? { ...updated, statusKept: 'REVOKED' } : updated,
        before: existing,
      });
      return keepRevoked
        ? { data: toDto(updated), statusKept: 'REVOKED' as const }
        : { data: toDto(updated) };
    }
  );

  app.delete(
    '/tool-catalog/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.toolCatalogEntry.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return sendError(reply, 404, 'NOT_FOUND', 'Tool catalog entry not found');
      }
      if (existing.isBuiltIn) {
        return sendError(
          reply,
          409,
          'BUILT_IN_TOOL',
          'A built-in tool cannot be deleted — gateway startup would re-create it. Revoke it instead.'
        );
      }
      try {
        await fastify.prisma.toolCatalogEntry.delete({ where: { id: existing.id } });
      } catch (err) {
        if (isRecordNotFoundError(err)) {
          return sendError(reply, 404, 'NOT_FOUND', 'Tool catalog entry not found');
        }
        throw err;
      }
      await audit(actor, 'DELETE', existing, { before: existing });
      return { data: { deleted: true, id: existing.id } };
    }
  );
};
