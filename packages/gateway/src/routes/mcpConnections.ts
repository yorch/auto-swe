import { isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Admin CRUD for `mcp`-type Connections (P2/WS3): the MCP servers an Agent can
 * bind tools from via `Agent.mcpConnectionId`. An `mcp` Connection is a normal
 * `Connection` row with `type='mcp'` and the server URL in `config.url`; the git
 * identity columns stay null. http(s) only — stdio is intentionally unsupported.
 */
const CreateSchema = z.object({
  /** Optional per-connection override of `loadMcpTools`'s per-call timeout (default 60 s). */
  callTimeoutMs: z.number().int().positive().optional(),
  /** Optional per-connection override of `loadMcpTools`'s list-timeout (default 15 s). */
  listTimeoutMs: z.number().int().positive().optional(),
  name: z.string().min(1).max(200),
  teamId: z.string().uuid(),
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'url must be an http(s) URL'),
});

/**
 * Edit an existing `mcp` connection. `name` + `url` are always present (the edit
 * form is pre-filled); the two timeouts are optional and the handler rebuilds
 * `config` from scratch, so a blank timeout in the form clears the override back
 * to `loadMcpTools`'s default rather than leaving a stale value behind.
 */
const UpdateSchema = z.object({
  callTimeoutMs: z.number().int().positive().optional(),
  listTimeoutMs: z.number().int().positive().optional(),
  name: z.string().min(1).max(200),
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'url must be an http(s) URL'),
});

const IdParams = z.object({ id: z.string().uuid() });

function sanitizeAuditUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export const mcpConnectionRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  app.get('/mcp-connections', { onRequest: adminOnly }, async () => {
    const rows = await runUnscoped("admin lists every team's mcp connections", ['Connection'], () =>
      fastify.prisma.connection.findMany({
        include: { team: { select: { id: true, name: true, slug: true } } },
        orderBy: { name: 'asc' },
        where: { isActive: true, type: 'mcp' },
      })
    );
    return { data: rows };
  });

  app.post(
    '/mcp-connections',
    { onRequest: adminOnly, schema: { body: CreateSchema } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { name, teamId, url, listTimeoutMs, callTimeoutMs } = request.body;
      const safety = isSafeProbeUrl(url);
      if (!safety.ok) {
        return reply
          .status(400)
          .send({ error: { code: 'UNSAFE_URL', message: `url rejected: ${safety.reason}` } });
      }
      const team = await fastify.prisma.team.findUnique({ where: { id: teamId } });
      if (!team?.isActive) {
        return reply
          .status(404)
          .send({ error: { code: 'TEAM_NOT_FOUND', message: 'Team not found or inactive' } });
      }
      const config = {
        url,
        ...(listTimeoutMs !== undefined ? { listTimeoutMs } : {}),
        ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
      };
      const conn = await fastify.prisma.connection.create({
        data: { config, name, teamId, type: 'mcp' },
        include: { team: { select: { id: true, name: true, slug: true } } },
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: { ...config, name, type: 'mcp', url: sanitizeAuditUrl(url) },
        entityId: conn.id,
        entityType: 'Connection',
      });
      return reply.status(201).send({ data: conn });
    }
  );

  app.patch(
    '/mcp-connections/:id',
    { onRequest: adminOnly, schema: { body: UpdateSchema, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { name, url, listTimeoutMs, callTimeoutMs } = request.body;
      // Scope to type='mcp' so this route can never mutate a git_repo connection.
      const conn = await fastify.prisma.connection.findFirst({
        where: { id: request.params.id, type: 'mcp' },
      });
      if (!conn) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'MCP connection not found' } });
      }
      const safety = isSafeProbeUrl(url);
      if (!safety.ok) {
        return reply
          .status(400)
          .send({ error: { code: 'UNSAFE_URL', message: `url rejected: ${safety.reason}` } });
      }
      const before = conn.config as Record<string, unknown> | null;
      const beforeAudit = {
        ...(before ?? {}),
        name: conn.name,
        type: 'mcp',
        ...(typeof before?.url === 'string' ? { url: sanitizeAuditUrl(before.url) } : {}),
      };
      const config = {
        url,
        ...(listTimeoutMs !== undefined ? { listTimeoutMs } : {}),
        ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
      };
      const updated = await fastify.prisma.connection.update({
        data: { config, name },
        include: { team: { select: { id: true, name: true, slug: true } } },
        where: { id: conn.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { ...config, name, type: 'mcp', url: sanitizeAuditUrl(url) },
        before: beforeAudit,
        entityId: conn.id,
        entityType: 'Connection',
      });
      return reply.send({ data: updated });
    }
  );

  app.delete(
    '/mcp-connections/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      // Scope to type='mcp' so this route can never deactivate a git_repo.
      const conn = await fastify.prisma.connection.findFirst({
        where: { id: request.params.id, type: 'mcp' },
      });
      if (!conn) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'MCP connection not found' } });
      }
      // Soft-delete: Agents may still reference it via mcpConnectionId; an
      // inactive connection resolves to no MCP tools (mcpUrlForConnection).
      await fastify.prisma.connection.update({
        data: { isActive: false },
        where: { id: conn.id },
      });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: { name: conn.name },
        entityId: conn.id,
        entityType: 'Connection',
      });
      return reply.send({ data: { deactivated: true } });
    }
  );
};
