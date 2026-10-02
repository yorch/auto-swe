import { Readable } from 'node:stream';
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type OAuthMetadata,
  type OAuthTokenVerifier,
  originValidationResponse,
  ProtocolError,
  UnsupportedProtocolVersionError,
  verifyBearerToken,
} from '@modelcontextprotocol/server';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withClientIp } from '../lib/mcp/bridge.js';
import { createMcpToolServer, WRITE_TOOL_NAMES } from '../lib/mcp/tools.js';
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from '../lib/mcpOAuth.js';

/**
 * The MCP endpoint: a stateless Streamable HTTP server that is an OAuth 2.1 resource server.
 *
 * Mounted unconditionally; `mcp.enabled` is read per request and a disabled deployment answers 404
 * from every route here, so the switch needs no restart. The tools (`lib/mcp/tools.ts`) reach data
 * only through the REST routes, by the bridge (`lib/mcp/bridge.ts`), which `mcpBridgePlugin` must
 * have registered on the root instance first. This file imports no database access.
 */

type McpSettings = { enabled: boolean; writeToolsEnabled: boolean };

export interface McpRouteOptions {
  /** The RFC 8707 resource identifier, which is also this endpoint's public URL. */
  resource: string;
  /** The authorization server's issuer, advertised as the resource's `authorization_servers`. */
  issuer: string;
  /** Validates a bearer token; see `createMcpTokenVerifier`. */
  verifier: OAuthTokenVerifier;
  /** Read per request through the settings cache; a failure answers 503 rather than guessing. */
  getSettings: () => Promise<McpSettings>;
  /** Hostnames a browser `Origin` may carry (DNS-rebinding and CSRF defence). No `Origin` passes. */
  allowedOriginHostnames: string[];
  serverVersion: string;
  /** The dashboard's public origin, for the links tool results carry. */
  dashboardOrigin: string;
  /** `host[:port]` of every GitHub the platform is configured for (a pull request link must be on one). */
  getGitHubHosts: () => Promise<readonly string[]>;
}

/** The scopes this server will accept now: write is advertised only while writes are enabled. */
function supportedScopes(writeToolsEnabled: boolean): string[] {
  return writeToolsEnabled ? [MCP_SCOPE_READ, MCP_SCOPE_WRITE] : [MCP_SCOPE_READ];
}

/** Whether a JSON-RPC body (one message or a batch) calls a tool that needs `mcp:write`. */
function callsWriteTool(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => {
    const message = m as { method?: unknown; params?: { name?: unknown } } | null;
    return (
      message?.method === 'tools/call' &&
      typeof message.params?.name === 'string' &&
      WRITE_TOOL_NAMES.has(message.params.name)
    );
  });
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

/**
 * Errors the SDK reports through `onerror` that are a client's fault (a request it refused),
 * not ours. They stay at debug so they cannot flood the log; anything else is a fault inside
 * the handler that answered 500, and is logged at error. Only the error is logged, never the
 * request: its body and `Authorization` header stay out of the log.
 */
const CLIENT_REJECTION = /^(Rejected |Unsupported Media Type|subscriptions\/listen refused)/;
export function logSdkError(log: Pick<FastifyBaseLogger, 'debug' | 'error'>, err: Error) {
  if (
    err instanceof ProtocolError ||
    err instanceof UnsupportedProtocolVersionError ||
    CLIENT_REJECTION.test(err.message)
  ) {
    log.debug({ err }, 'mcp: request refused by the transport');
  } else {
    log.error({ err }, 'mcp: the transport failed');
  }
}

export async function mcpRoutes(app: FastifyInstance, options: McpRouteOptions) {
  const resourceUrl = new URL(options.resource);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const resourcePath = resourceUrl.pathname;

  const bridge = app.mcpBridge;
  if (!bridge) {
    throw new Error('mcpBridgePlugin must be registered on the root instance before mcpRoutes');
  }
  const toolDeps = {
    app,
    bridge,
    dashboardOrigin: options.dashboardOrigin,
    getGitHubHosts: options.getGitHubHosts,
    serverVersion: options.serverVersion,
  };

  // The factory runs once per HTTP request, with the verified token, so the tool list is decided
  // per request.
  const handler = createMcpHandler((ctx) => createMcpToolServer(toolDeps, ctx.authInfo), {
    // No subscription capability is advertised, and `subscriptions/listen` is an SSE stream the
    // gateway would have to hold open per client: refuse every one.
    maxSubscriptions: 0,
    onerror: (err) => logSdkError(app.log, err),
    // The default (2025-era) stateless fallback stays on: GET and DELETE are 405 there.
    // `auto` answers a single JSON body unless a handler emits a related message (progress,
    // logging) before its result, and then streams it. The read tools emit none, so a modern
    // client gets JSON either way; `json` would instead drop such a message without a word, and
    // warns at boot that it does.
    responseMode: 'auto',
  });
  app.addHook('onClose', async () => {
    await handler.close();
  });

  const settingsByRequest = new WeakMap<FastifyRequest, McpSettings>();

  /**
   * Runs before the body is parsed, so a disabled endpoint answers 404 whatever the request
   * carries (not 415, 400 or 413). If MCP is on the settings are kept for the handler; otherwise
   * the refusal has been sent.
   */
  async function requireEnabled(request: FastifyRequest, reply: FastifyReply) {
    try {
      const settings = await options.getSettings();
      if (settings.enabled) {
        settingsByRequest.set(request, settings);
        return;
      }
      notFound(reply);
    } catch (err) {
      request.log.error({ err }, 'mcp: could not read settings');
      reply
        .status(503)
        .send({ error: 'temporarily_unavailable', error_description: 'Try again shortly' });
    }
    return reply;
  }

  // RFC 9728 Protected Resource Metadata, at the path-inserted URL clients derive from the
  // resource identifier and at the root.
  const metadataHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const settings = settingsByRequest.get(request) as McpSettings;
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
  app.get(
    `/.well-known/oauth-protected-resource${resourcePath}`,
    { onRequest: requireEnabled },
    metadataHandler
  );
  app.get('/.well-known/oauth-protected-resource', { onRequest: requireEnabled }, metadataHandler);

  const serve = async (request: FastifyRequest, reply: FastifyReply) => {
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
    // The URL comes from configuration, never from the `Host` header: a client-chosen host that
    // is not a valid URL authority would make this constructor throw.
    const webRequest = new Request(`${resourceUrl.origin}${request.url}`, {
      ...(body !== undefined && request.method !== 'GET' && request.method !== 'DELETE'
        ? { body }
        : {}),
      headers,
      method: request.method,
      signal: abort.signal,
    });

    // A browser Origin that is not ours is refused before anything else is learned about it.
    const badOrigin = originValidationResponse(webRequest, options.allowedOriginHostnames);
    if (badOrigin) {
      return sendWebResponse(reply, badOrigin);
    }

    // RFC 6750 section 3.1: a request with no credentials gets a challenge without an error code.
    if (!request.headers.authorization) {
      return reply
        .status(401)
        .header(
          'www-authenticate',
          `Bearer scope="${MCP_SCOPE_READ}", resource_metadata="${resourceMetadataUrl}"`
        )
        .send({ error: 'invalid_request', error_description: 'Missing Authorization header' });
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

    // Step-up: a token without `mcp:write` that calls a write tool is told which scope to ask
    // for (RFC 6750 section 3.1), instead of the tool being reported as unknown. Only while
    // writes are enabled: with them off, `mcp:write` cannot be granted, so the tool does not
    // exist and asking for the scope would send the user round a consent that is refused.
    const settings = settingsByRequest.get(request) as McpSettings;
    if (
      settings.writeToolsEnabled &&
      !authInfo.scopes.includes(MCP_SCOPE_WRITE) &&
      callsWriteTool(request.body)
    ) {
      return sendWebResponse(
        reply,
        bearerAuthChallengeResponse(
          new OAuthError(OAuthErrorCode.InsufficientScope, 'Insufficient scope'),
          { requiredScopes: [MCP_SCOPE_WRITE], resourceMetadataUrl }
        )
      );
    }

    // The client's address rides along so a tool's inner call is rate limited as the client is.
    return sendWebResponse(
      reply,
      await handler.fetch(webRequest, { authInfo: withClientIp(authInfo, request.ip) })
    );
  };
  app.route({
    handler: serve,
    method: ['GET', 'POST', 'DELETE'],
    onRequest: requireEnabled,
    url: resourcePath,
  });
}
