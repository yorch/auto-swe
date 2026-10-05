import { decryptSecret, encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  MAX_MCP_HEADERS,
  type McpHeader,
  NO_HEADER_COLUMNS,
  openMcpHeaders,
  sealMcpHeaders,
  validateMcpHeaders,
} from '@auto-swe/shared/lib/mcpHeaders';
import { checkProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
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
 *
 * An optional bearer token is stored in the Connection's existing AES-256-GCM `apiKey*` envelope
 * columns (unused by `mcp` rows), never in `config`. It is write-only: no response carries it, the
 * audit trail records only whether one is set, and it is sent only to the connection's own origin.
 *
 * Up to five custom headers follow the same rules in `headers*` columns (one sealed JSON list):
 * responses and the audit trail carry their NAMES only. `Authorization` is not a custom header; the
 * bearer token is where that credential lives. `config.allowPrivateNetwork` is the admin's opt-in
 * for a server on an internal address, with the connectors' guard semantics: private ranges only,
 * never loopback, link-local, unspecified or a metadata endpoint.
 */
const BearerToken = z
  .string()
  .min(1)
  .max(4096)
  // A header value: visible ASCII only, so a pasted newline cannot smuggle in another header.
  .regex(/^[\x21-\x7e]+$/, 'The token must be visible characters with no spaces or line breaks');

const HeaderName = z.string().min(1).max(100);
const HeaderValue = z.string().min(1).max(2048);

const CreateSchema = z.object({
  /** Waives the private-network refusal for this connection's server (never loopback/metadata). */
  allowPrivateNetwork: z.boolean().optional(),
  /** Optional bearer token the server requires; sent as `Authorization: Bearer …`. */
  bearerToken: BearerToken.optional(),
  /** Optional per-connection override of `loadMcpTools`'s per-call timeout (default 60 s). */
  callTimeoutMs: z.number().int().positive().optional(),
  /** Custom request headers; values are sealed and never returned. */
  headers: z
    .array(z.object({ name: HeaderName, value: HeaderValue }))
    .max(MAX_MCP_HEADERS)
    .optional(),
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
const UpdateSchema = z
  .object({
    allowPrivateNetwork: z.boolean().optional(),
    /** Replaces the stored token. Omit to keep it. */
    bearerToken: BearerToken.optional(),
    callTimeoutMs: z.number().int().positive().optional(),
    /** Removes the stored token. Cannot be combined with `bearerToken`. */
    clearBearerToken: z.boolean().optional(),
    /**
     * The complete header set after the edit. A row with a `value` sets it; a row without one keeps
     * the stored value of that name. Omit the field to keep every header; send `[]` to remove all.
     */
    headers: z
      .array(z.object({ name: HeaderName, value: HeaderValue.optional() }))
      .max(MAX_MCP_HEADERS)
      .optional(),
    listTimeoutMs: z.number().int().positive().optional(),
    name: z.string().min(1).max(200),
    url: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), 'url must be an http(s) URL'),
  })
  .refine((b) => !(b.bearerToken !== undefined && b.clearBearerToken), {
    message: 'Send either a new token or clearBearerToken, not both',
  });

const IdParams = z.object({ id: z.string().uuid() });

/** The envelope columns a stored token occupies (`apiKey*` on Connection). */
function tokenColumns(token: string) {
  const enc = encryptSecret(token);
  return {
    apiKeyAuthTag: enc.authTag,
    apiKeyCiphertext: enc.ciphertext,
    apiKeyNonce: enc.nonce,
    apiKeyVersion: enc.keyVersion,
  };
}

const NO_TOKEN_COLUMNS = {
  apiKeyAuthTag: null,
  apiKeyCiphertext: null,
  apiKeyNonce: null,
};

/**
 * Wire shape of an `mcp` connection: the shared redaction (envelope columns removed) with the
 * boolean renamed for this surface. The token itself, and even its last characters, never leave.
 */
function mcpView<T extends Parameters<typeof redactConnection>[0]>(row: T) {
  const { hasApiToken, ...rest } = redactConnection(row);
  const names = headerNamesOf(row);
  return { ...rest, hasToken: hasApiToken, headerNames: names.names, headersUnreadable: names.bad };
}

/** The NAMES of a row's stored headers; a row that cannot be opened reports `bad`, never values. */
function headerNamesOf(row: Parameters<typeof openMcpHeaders>[0]): {
  names: string[];
  bad: boolean;
} {
  try {
    return { bad: false, names: openMcpHeaders(row).map((h) => h.name) };
  } catch {
    return { bad: true, names: [] };
  }
}

function safeOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

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
    return { data: rows.map((r) => ({ ...mcpView(r), usedBy: usedBy.get(r.id) ?? [] })) };
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
      const config = (conn.config ?? {}) as {
        url?: unknown;
        listTimeoutMs?: unknown;
        allowPrivateNetwork?: unknown;
      };
      const safety =
        typeof config.url === 'string'
          ? checkProbeUrl(config.url, { allowPrivate: config.allowPrivateNetwork === true })
          : null;
      if (!(safety?.ok && typeof config.url === 'string')) {
        return {
          data: { durationMs: 0, error: 'The saved server URL is not allowed.', ok: false },
        };
      }
      const timeoutMs =
        typeof config.listTimeoutMs === 'number' && config.listTimeoutMs > 0
          ? config.listTimeoutMs
          : 15_000;
      // Decrypted only here, handed to the probe, and never logged or returned. A row whose
      // envelope no longer decrypts is reported rather than probed unauthenticated.
      let bearerToken: string | undefined;
      if (conn.apiKeyCiphertext && conn.apiKeyNonce && conn.apiKeyAuthTag) {
        try {
          bearerToken = decryptSecret({
            authTag: conn.apiKeyAuthTag,
            ciphertext: conn.apiKeyCiphertext,
            keyVersion: conn.apiKeyVersion,
            nonce: conn.apiKeyNonce,
          });
        } catch {
          return {
            data: {
              durationMs: 0,
              error: 'The stored token could not be read. Clear it and enter it again.',
              ok: false,
            },
          };
        }
      }
      let headers: McpHeader[];
      try {
        headers = openMcpHeaders(conn);
      } catch {
        return {
          data: {
            durationMs: 0,
            error: 'The stored headers could not be read. Re-enter them and save again.',
            ok: false,
          },
        };
      }
      return {
        data: await probeMcpServer(config.url, timeoutMs, undefined, { bearerToken, headers }),
      };
    }
  );

  app.post(
    '/mcp-connections',
    { onRequest: adminOnly, schema: { body: CreateSchema } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { name, teamId, url, listTimeoutMs, callTimeoutMs, bearerToken, headers } =
        request.body;
      const allowPrivateNetwork = request.body.allowPrivateNetwork === true;
      const safety = checkProbeUrl(url, { allowPrivate: allowPrivateNetwork });
      if (!safety.ok) {
        return reply
          .status(400)
          .send({ error: { code: 'UNSAFE_URL', message: `url rejected: ${safety.reason}` } });
      }
      const headerProblem = headers ? validateMcpHeaders(headers) : null;
      if (headerProblem) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_HEADERS', message: headerProblem } });
      }
      const team = await fastify.prisma.team.findUnique({ where: { id: teamId } });
      if (!team?.isActive) {
        return reply
          .status(404)
          .send({ error: { code: 'TEAM_NOT_FOUND', message: 'Team not found or inactive' } });
      }
      const config = {
        url,
        ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
        ...(listTimeoutMs !== undefined ? { listTimeoutMs } : {}),
        ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
      };
      const conn = await fastify.prisma.connection.create({
        data: {
          config,
          name,
          teamId,
          type: 'mcp',
          ...(bearerToken ? tokenColumns(bearerToken) : {}),
          ...(headers?.length ? sealMcpHeaders(headers) : {}),
        },
        include: { team: { select: { id: true, name: true, slug: true } } },
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: {
          ...config,
          hasToken: !!bearerToken,
          headerNames: (headers ?? []).map((h) => h.name),
          name,
          type: 'mcp',
          url: sanitizeAuditUrl(url),
        },
        entityId: conn.id,
        entityType: 'Connection',
      });
      return reply.status(201).send({ data: mcpView(conn) });
    }
  );

  app.patch(
    '/mcp-connections/:id',
    { onRequest: adminOnly, schema: { body: UpdateSchema, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { name, url, listTimeoutMs, callTimeoutMs, bearerToken, clearBearerToken } =
        request.body;
      const allowPrivateNetwork = request.body.allowPrivateNetwork === true;
      // Scope to type='mcp' so this route can never mutate a git_repo connection.
      const conn = await fastify.prisma.connection.findFirst({
        where: { id: request.params.id, type: 'mcp' },
      });
      if (!conn) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'MCP connection not found' } });
      }
      const safety = checkProbeUrl(url, { allowPrivate: allowPrivateNetwork });
      if (!safety.ok) {
        return reply
          .status(400)
          .send({ error: { code: 'UNSAFE_URL', message: `url rejected: ${safety.reason}` } });
      }
      const before = conn.config as Record<string, unknown> | null;
      const hadToken = conn.apiKeyCiphertext != null;
      // A stored token belongs to the origin it was saved for. Pointing the connection at another
      // origin while keeping it would send the token somewhere its owner never approved.
      if (hadToken && bearerToken === undefined && !clearBearerToken) {
        const previous = typeof before?.url === 'string' ? safeOrigin(before.url) : null;
        if (previous !== safeOrigin(url)) {
          return reply.status(409).send({
            error: {
              code: 'TOKEN_ORIGIN_CHANGE',
              message:
                'This connection has a stored bearer token. Changing the server address would send it to a different host. Enter a new token or clear the stored one first.',
            },
          });
        }
      }
      // The same rule for custom headers: a stored value belongs to the origin it was saved for.
      let storedHeaders: McpHeader[] = [];
      try {
        storedHeaders = openMcpHeaders(conn);
      } catch {
        // Unreadable stored headers can only be replaced, never kept.
        if (request.body.headers === undefined) {
          return reply.status(409).send({
            error: {
              code: 'HEADERS_UNREADABLE',
              message: 'The stored headers could not be read. Re-enter them or remove them.',
            },
          });
        }
      }
      let nextHeaders: McpHeader[] | undefined;
      if (request.body.headers !== undefined) {
        const byName = new Map(storedHeaders.map((h) => [h.name.toLowerCase(), h.value]));
        nextHeaders = [];
        for (const h of request.body.headers) {
          const value = h.value ?? byName.get(h.name.toLowerCase());
          if (value === undefined) {
            return reply.status(400).send({
              error: {
                code: 'INVALID_HEADERS',
                message: `Enter a value for the ${h.name} header; none is stored.`,
              },
            });
          }
          nextHeaders.push({ name: h.name, value });
        }
        const problem = validateMcpHeaders(nextHeaders);
        if (problem) {
          return reply.status(400).send({ error: { code: 'INVALID_HEADERS', message: problem } });
        }
      }
      const keptStoredValues =
        nextHeaders === undefined
          ? storedHeaders.length > 0
          : request.body.headers?.some((h) => h.value === undefined) === true;
      if (keptStoredValues) {
        const previous = typeof before?.url === 'string' ? safeOrigin(before.url) : null;
        if (previous !== safeOrigin(url)) {
          return reply.status(409).send({
            error: {
              code: 'HEADERS_ORIGIN_CHANGE',
              message:
                'This connection has stored headers. Changing the server address would send them to a different host. Enter their values again or remove them first.',
            },
          });
        }
      }
      const finalHeaderNames = (nextHeaders ?? storedHeaders).map((h) => h.name);
      const beforeAudit = {
        ...(before ?? {}),
        hasToken: hadToken,
        headerNames: storedHeaders.map((h) => h.name),
        name: conn.name,
        type: 'mcp',
        ...(typeof before?.url === 'string' ? { url: sanitizeAuditUrl(before.url) } : {}),
      };
      const config = {
        url,
        ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
        ...(listTimeoutMs !== undefined ? { listTimeoutMs } : {}),
        ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
      };
      const updated = await fastify.prisma.connection.update({
        data: {
          config,
          name,
          ...(bearerToken !== undefined ? tokenColumns(bearerToken) : {}),
          ...(clearBearerToken ? NO_TOKEN_COLUMNS : {}),
          ...(nextHeaders === undefined
            ? {}
            : nextHeaders.length > 0
              ? sealMcpHeaders(nextHeaders)
              : NO_HEADER_COLUMNS),
        },
        include: { team: { select: { id: true, name: true, slug: true } } },
        where: { id: conn.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: {
          ...config,
          hasToken: bearerToken !== undefined ? true : clearBearerToken ? false : hadToken,
          headerNames: finalHeaderNames,
          name,
          type: 'mcp',
          url: sanitizeAuditUrl(url),
        },
        before: beforeAudit,
        entityId: conn.id,
        entityType: 'Connection',
      });
      return reply.send({ data: mcpView(updated) });
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
