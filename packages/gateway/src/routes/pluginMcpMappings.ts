import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { validateMcpConnectionRef } from '../lib/agentLibraryService.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { declaredFromSnapshot, MAPPING_SELECT, mappingDto } from '../lib/pluginMcpMappings.js';
import { requireUser } from '../plugins/auth.js';

const Params = z.object({
  name: z.string().min(1).max(64),
  serverName: z.string().min(1).max(128),
});
const PutBody = z.object({ connectionId: z.string().uuid() });

/**
 *   PUT    /api/v1/platform/harness-profiles/:name/mcp-mappings/:serverName   Map a declared HTTP server to an `mcp` Connection
 *   DELETE /api/v1/platform/harness-profiles/:name/mcp-mappings/:serverName   Remove the mapping (also an orphaned one)
 *
 * ADMIN-only like the other profile routes. The audit rows name the server and the connection id,
 * never a URL or connection config. See `docs/harness-profiles.md`.
 */
export function registerPluginMcpMappingRoutes(fastify: FastifyInstance, adminOnly: unknown): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const onRequest = adminOnly as never;
  const notFound = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 404, 'NOT_FOUND', 'Harness profile not found');

  app.put(
    '/harness-profiles/:name/mcp-mappings/:serverName',
    { onRequest, schema: { body: PutBody, params: Params } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { name, serverName } = request.params;
      const profile = await fastify.prisma.harnessProfile.findUnique({
        select: { id: true, latestVersion: true, name: true, status: true },
        where: { name },
      });
      if (!profile) {
        return notFound(reply);
      }
      if (profile.status === 'DISABLED') {
        return sendError(reply, 409, 'HARNESS_PROFILE_DISABLED', 'The plugin is disabled');
      }
      const latest = await fastify.prisma.harnessProfileVersion.findUnique({
        select: { files: true, manifest: true },
        where: { profileId_version: { profileId: profile.id, version: profile.latestVersion } },
      });
      const server = latest
        ? declaredFromSnapshot(latest.files, latest.manifest).declared.servers.find(
            (s) => s.name === serverName
          )
        : undefined;
      if (!server) {
        return sendError(
          reply,
          400,
          'MCP_SERVER_NOT_DECLARED',
          'The latest version of the plugin does not declare this MCP server'
        );
      }
      if (!server.supported) {
        return sendError(
          reply,
          400,
          'MCP_SERVER_UNSUPPORTED',
          'Only HTTP MCP servers can be mapped; stdio and sse servers are not supported'
        );
      }
      if (server.duplicate) {
        return sendError(
          reply,
          400,
          'MCP_SERVER_AMBIGUOUS',
          'Another plugin of this profile declares an MCP server with the same name'
        );
      }
      const { connectionId } = request.body;
      // The same rule as an Agent's `mcpConnectionId`; a mapping is an admin write, so GLOBAL scope.
      const invalid = await validateMcpConnectionRef(fastify.prisma, connectionId, {
        scope: 'GLOBAL',
      });
      if (invalid) {
        return sendError(
          reply,
          400,
          'MCP_CONNECTION_INVALID',
          'The connection must be an active mcp connection'
        );
      }
      const row = await fastify.prisma.$transaction(async (tx) => {
        const before = await tx.pluginMcpMapping.findUnique({
          select: { connectionId: true },
          where: { profileId_serverName: { profileId: profile.id, serverName } },
        });
        const saved = await tx.pluginMcpMapping.upsert({
          create: { connectionId, mappedById: actor.sub, profileId: profile.id, serverName },
          select: MAPPING_SELECT,
          update: { connectionId, mappedById: actor.sub },
          where: { profileId_serverName: { profileId: profile.id, serverName } },
        });
        await writeAuditLog(fastify, {
          action: before ? 'UPDATE' : 'CREATE',
          actor,
          after: { connectionId, mcpMapping: serverName, name: profile.name },
          before: before ? { connectionId: before.connectionId, mcpMapping: serverName } : null,
          client: tx,
          entityId: profile.id,
          entityType: 'HarnessProfile',
        });
        return saved;
      });
      return { data: mappingDto(row) };
    }
  );

  app.delete(
    '/harness-profiles/:name/mcp-mappings/:serverName',
    { onRequest, schema: { params: Params } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { name, serverName } = request.params;
      const profile = await fastify.prisma.harnessProfile.findUnique({
        select: { id: true, name: true },
        where: { name },
      });
      if (!profile) {
        return notFound(reply);
      }
      const found = await fastify.prisma.$transaction(async (tx) => {
        const before = await tx.pluginMcpMapping.findUnique({
          select: { connectionId: true },
          where: { profileId_serverName: { profileId: profile.id, serverName } },
        });
        if (!before) {
          return false;
        }
        await tx.pluginMcpMapping.delete({
          where: { profileId_serverName: { profileId: profile.id, serverName } },
        });
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor,
          after: null,
          before: { connectionId: before.connectionId, mcpMapping: serverName, name: profile.name },
          client: tx,
          entityId: profile.id,
          entityType: 'HarnessProfile',
        });
        return true;
      });
      if (!found) {
        return sendError(reply, 404, 'NOT_FOUND', 'MCP mapping not found');
      }
      return reply.status(204).send();
    }
  );
}
