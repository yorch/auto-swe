import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { MCP_GRANT_ENTITY } from './mcpGrants.js';
import { AUTH_BASE_PATH } from './mcpOAuth.js';

/**
 * Records a consent decision that granted access, as a `ConfigAuditLog` row.
 *
 * The consent endpoint belongs to the OAuth provider, which writes the consent row itself, so
 * the record is made after the response, from what the provider stored. It is best-effort:
 * the grant already exists by then, and a failed audit write is logged rather than turned
 * into an error for a client mid-authorization. Revocations are audited inside the
 * revocation's own transaction (`mcpGrants.ts`).
 */

const CONSENT = `${AUTH_BASE_PATH}/oauth2/consent`;

export interface McpConsentAuditOptions {
  /** The id of the user behind the request's session cookie, or null when there is none. */
  getSessionUserId: (request: FastifyRequest) => Promise<string | null>;
}

export const mcpConsentAudit = fp<McpConsentAuditOptions>(
  async (app: FastifyInstance, options) => {
    const startedAt = new WeakMap<FastifyRequest, number>();

    app.addHook('onRequest', async (request) => {
      if (request.method === 'POST' && request.url.split('?')[0] === CONSENT) {
        startedAt.set(request, Date.now());
      }
    });

    app.addHook('onResponse', async (request, reply) => {
      const started = startedAt.get(request);
      if (started === undefined || reply.statusCode !== 200) {
        return;
      }
      const body = request.body as { accept?: unknown; oauth_query?: unknown } | null;
      if (body?.accept !== true || typeof body.oauth_query !== 'string') {
        return;
      }
      const clientId = new URLSearchParams(body.oauth_query).get('client_id');
      try {
        const userId = await options.getSessionUserId(request);
        if (!(userId && clientId)) {
          return;
        }
        const { prisma } = app;
        const consent = await prisma.oauthConsent.findFirst({
          orderBy: { updatedAt: 'desc' },
          where: { clientId, userId },
        });
        // The provider stamps consent times to the second; a row older than this request
        // means the request granted nothing (it resumed authorization instead).
        if (!consent || consent.updatedAt.getTime() < Math.floor(started / 1000) * 1000) {
          return;
        }
        await prisma.configAuditLog.create({
          data: {
            action: 'CREATE',
            actorId: userId,
            afterJson: { clientId, scopes: consent.scopes, userId } as never,
            beforeJson: null as never,
            entityId: consent.id,
            entityType: MCP_GRANT_ENTITY,
          },
        });
      } catch (err) {
        request.log.error({ err }, 'mcp consent audit: could not record the grant');
      }
    });
  },
  { fastify: '5.x', name: 'mcp-consent-audit' }
);
