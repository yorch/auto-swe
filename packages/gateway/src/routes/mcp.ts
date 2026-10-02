import { Readable } from 'node:stream';
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  OAuthError,
  type OAuthMetadata,
  type OAuthTokenVerifier,
  originValidationResponse,
  verifyBearerToken,
} from '@modelcontextprotocol/server';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from '../lib/mcpOAuth.js';

/**
 * The MCP endpoint: a stateless Streamable HTTP server that is an OAuth 2.1 resource server.
 *
 * Mounted unconditionally; `mcp.enabled` is read per request and a disabled deployment answers 404
 * from every route here, so the switch needs no restart. This PR registers no tools, so an
 * authenticated client can `initialize` and list an empty tool set and nothing else.
 */

export interface McpRouteOptions {
  /** The RFC 8707 resource identifier, which is also this endpoint's public URL. */
  resource: string;
  /** The authorization server's issuer, advertised as the resource's `authorization_servers`. */
  issuer: string;
  /** Validates a bearer token; see `createMcpTokenVerifier`. */
  verifier: OAuthTokenVerifier;
  /** Read per request through the settings cache; a failure answers 503 rather than guessing. */
  getSettings: () => Promise<{ enabled: boolean; writeToolsEnabled: boolean }>;
  /** Hostnames a browser `Origin` may carry (DNS-rebinding and CSRF defence). No `Origin` passes. */
  allowedOriginHostnames: string[];
  serverVersion: string;
}

/** The scopes this server will accept now: write is advertised only while writes are enabled. */
function supportedScopes(writeToolsEnabled: boolean): string[] {
  return writeToolsEnabled ? [MCP_SCOPE_READ, MCP_SCOPE_WRITE] : [MCP_SCOPE_READ];
}

function notFound(reply: FastifyReply) {
  return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
}

/** Write a web `Response` to the Fastify reply, streaming its body. */
async function sendWebResponse(reply: FastifyReply, response: Response) {
  reply.status(response.status);
  response.headers.forEach((value, key) => {
    // The stream's length is the transport's business; Fastify frames it.
    if (key !== 'content-length') {
      reply.header(key, value);
    }
  });
  if (!response.body || response.status === 204 || response.status === 304) {
    return reply.send();
  }
  return reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
}

export async function mcpRoutes(app: FastifyInstance, options: McpRouteOptions) {
  const resourceUrl = new URL(options.resource);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const resourcePath = resourceUrl.pathname;

  // The factory runs once per HTTP request. Nothing is registered: `tools/list` is empty.
  const handler = createMcpHandler(
    () =>
      new McpServer(
        { name: 'auto-swe', version: options.serverVersion },
        { capabilities: { tools: {} } }
      ),
    {
      // No subscription capability is advertised, and `subscriptions/listen` is an SSE stream the
      // gateway would have to hold open per client: refuse every one.
      maxSubscriptions: 0,
      onerror: (err) => app.log.debug({ err }, 'mcp transport'),
      // The default (2025-era) stateless fallback stays on: GET and DELETE are 405 there.
      responseMode: 'json',
    }
  );
  app.addHook('onClose', async () => {
    await handler.close();
  });

  /** The settings when MCP is on; otherwise the refusal has been sent and this is null. */
  async function gate(request: FastifyRequest, reply: FastifyReply) {
    try {
      const settings = await options.getSettings();
      if (settings.enabled) {
        return settings;
      }
      notFound(reply);
    } catch (err) {
      request.log.error({ err }, 'mcp: could not read settings');
      reply
        .status(503)
        .send({ error: 'temporarily_unavailable', error_description: 'Try again shortly' });
    }
    return null;
  }

  // RFC 9728 Protected Resource Metadata, at the path-inserted URL clients derive from the
  // resource identifier and at the root.
  const metadataHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const settings = await gate(request, reply);
    if (!settings) {
      return reply;
    }
    try {
      const document = buildOAuthProtectedResourceMetadata({
        // Only the issuer is read from this.
        oauthMetadata: { issuer: options.issuer } as OAuthMetadata,
        resourceName: 'auto-swe MCP',
        resourceServerUrl: resourceUrl,
        scopesSupported: supportedScopes(settings.writeToolsEnabled),
      });
      return reply.header('cache-control', 'no-store').send(document);
    } catch (err) {
      // The SDK refuses a non-HTTPS issuer outside localhost: a misconfigured BETTER_AUTH_URL.
      request.log.error({ err }, 'mcp: cannot build the protected resource metadata');
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
    }
  };
  app.get(`/.well-known/oauth-protected-resource${resourcePath}`, metadataHandler);
  app.get('/.well-known/oauth-protected-resource', metadataHandler);

  const serve = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await gate(request, reply))) {
      return reply;
    }

    const abort = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) {
        abort.abort();
      }
    });
    const headers = fromNodeHeaders(request.headers);
    headers.delete('content-length');
    // Fastify has parsed the body already; the handler wants a `Request` it can read.
    const body =
      request.body === undefined || request.body === null
        ? undefined
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);
    const webRequest = new Request(
      `http://${request.headers.host ?? new URL(options.resource).host}${request.url}`,
      {
        ...(body !== undefined && request.method !== 'GET' && request.method !== 'DELETE'
          ? { body }
          : {}),
        headers,
        method: request.method,
        signal: abort.signal,
      }
    );

    // A browser Origin that is not ours is refused before anything else is learned about it.
    const badOrigin = originValidationResponse(webRequest, options.allowedOriginHostnames);
    if (badOrigin) {
      return sendWebResponse(reply, badOrigin);
    }

    let authInfo: AuthInfo;
    const challenge = { requiredScopes: [MCP_SCOPE_READ], resourceMetadataUrl };
    try {
      authInfo = await verifyBearerToken(request.headers.authorization, {
        verifier: options.verifier,
        ...challenge,
      });
    } catch (err) {
      // A refused token is the normal case; anything else (the keys or the database could not
      // be read) is ours, and answers 500.
      if (!(err instanceof OAuthError)) {
        request.log.error({ err }, 'mcp: token verification failed');
      }
      return sendWebResponse(reply, bearerAuthChallengeResponse(err, challenge));
    }

    return sendWebResponse(reply, await handler.fetch(webRequest, { authInfo }));
  };
  app.route({ handler: serve, method: ['GET', 'POST', 'DELETE'], url: resourcePath });
}
