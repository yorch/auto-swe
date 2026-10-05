import { isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { redactConnection } from '../lib/connectionRedaction.js';
import { probeMcpServer } from '../lib/mcpProbe.js';
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
    const usedBy = await agentsUsing(rows.map((r) => r.id));
    return { data: rows.map((r) => ({ ...redactConnection(r), usedBy: usedBy.get(r.id) ?? [] })) };
  });

  /**
   * The agents whose CURRENT version binds each connection. Older versions of an agent that
   * dropped the connection are history, not use, so only the highest version of a lineage counts.
   */
  async function agentsUsing(connectionIds: string[]) {
    const out = new Map<string, { key: string; name: string; scope: string }[]>();
    if (connectionIds.length === 0) {
      return out;
    }
    const candidates = await runUnscoped(
      'admin sees which agents bind an mcp connection',
      ['Agent'],
      () =>
        fastify.prisma.agent.findMany({
          select: {
            channelId: true,
            key: true,
            mcpConnectionId: true,
            name: true,
            orgId: true,
            scope: true,
            teamId: true,
            version: true,
            workflowTemplateId: true,
          },
          where: { isActive: true, mcpConnectionId: { in: connectionIds } },
        })
    );
    if (candidates.length === 0) {
      return out;
    }
    const latest = await runUnscoped(
      'admin sees which agents bind an mcp connection',
      ['Agent'],
      () =>
        fastify.prisma.agent.groupBy({
          _max: { version: true },
          by: ['key', 'scope', 'teamId', 'orgId', 'channelId', 'workflowTemplateId'],
          where: { isActive: true, key: { in: [...new Set(candidates.map((c) => c.key))] } },
        })
    );
    const lineage = (a: {
      key: string;
      scope: string;
      teamId: string | null;
      orgId: string | null;
      channelId: string | null;
      workflowTemplateId: string | null;
    }) =>
      [a.key, a.scope, a.teamId, a.orgId, a.channelId, a.workflowTemplateId].map(String).join('|');
    const top = new Map(latest.map((l) => [lineage(l), l._max.version]));
    for (const c of candidates) {
      if (c.mcpConnectionId && top.get(lineage(c)) === c.version) {
        const list = out.get(c.mcpConnectionId) ?? [];
        list.push({ key: c.key, name: c.name, scope: c.scope });
        out.set(c.mcpConnectionId, list);
      }
    }
    return out;
  }

  // POST /mcp-connections/:id/test — connect, initialize and list tools, within the connection's
  // own list timeout. Always 200 with `ok` so the page can show the reason; 404 only for no row.
  app.post(
    '/mcp-connections/:id/test',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const conn = await fastify.prisma.connection.findFirst({
        where: { id: request.params.id, isActive: true, type: 'mcp' },
      });
      if (!conn) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'MCP connection not found' } });
      }
      const config = (conn.config ?? {}) as { url?: unknown; listTimeoutMs?: unknown };
      const safety = typeof config.url === 'string' ? isSafeProbeUrl(config.url) : null;
      if (!(safety?.ok && typeof config.url === 'string')) {
        return {
          data: { durationMs: 0, error: 'The saved server URL is not allowed.', ok: false },
        };
      }
      const timeoutMs =
        typeof config.listTimeoutMs === 'number' && config.listTimeoutMs > 0
          ? config.listTimeoutMs
          : 15_000;
      return { data: await probeMcpServer(config.url, timeoutMs) };
    }
  );

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
      return reply.status(201).send({ data: redactConnection(conn) });
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
      return reply.send({ data: redactConnection(updated) });
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
