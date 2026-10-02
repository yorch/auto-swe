import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type AuthInfo, OAuthError, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/**
 * The bridge between an MCP tool call and the REST route that serves it.
 *
 * A tool never touches data itself: it makes an in-process `fastify.inject()` call to the same
 * route a REST client would call, so every role gate, visibility filter, tenant guard, rate limit
 * and audit write applies unchanged. Two things make that safe.
 *
 * 1. The inner call re-presents the caller's own OAuth access token, and `requireAuth` verifies it
 *    again with the same verifier the MCP route used. Identity is never asserted in a header, so
 *    the secret below, on its own, grants nothing.
 * 2. `requireAuth` accepts an MCP token only on a call that carries the per-boot secret AND a
 *    route that declares `config.mcpScope`. A token sent straight to a REST route is refused, and
 *    so is one sent to a route that did not opt in.
 *
 * This module imports no database access: MCP code reaches data only through a route.
 */

/** The header that marks an inner call. Built by the bridge, never forwarded from a client. */
export const MCP_BRIDGE_HEADER = 'x-auto-swe-mcp-bridge';

/** What a tool needs to know about who is calling. Derived from the verified `AuthInfo`. */
export interface McpCaller {
  /** The access token, re-presented to the inner route. Never logged, never returned. */
  token: string;
  userId: string;
  scopes: readonly string[];
  /** The client's address as the outer request saw it, so the inner call is rate limited as it. */
  clientIp: string;
}

export interface BridgeResponse {
  status: number;
  /** The parsed JSON body; undefined when there was none or it was not JSON. */
  body: unknown;
}

export interface McpBridge {
  /** Whether a request's bridge header is the secret. Anything but the exact string is refused. */
  accepts(headerValue: unknown): boolean;
  /**
   * The shared verifier, which is the one answer to "is this token good" for the MCP route and for
   * `requireAuth`. Null when the token is refused; a failure of the verifier's own dependencies
   * (the keys or the database cannot be read) throws, so it is never mistaken for a bad token.
   */
  verify(token: string): Promise<AuthInfo | null>;
  /** One GET to a REST route, as `caller`. */
  get(
    app: FastifyInstance,
    caller: McpCaller,
    path: string,
    query?: URLSearchParams
  ): Promise<BridgeResponse>;
  /**
   * One POST to a REST route, as `caller`. `body` is sent as JSON when given; `idempotencyKey`
   * becomes the `Idempotency-Key` header. Only a route that declares `mcpScope: 'write'` will
   * take it.
   */
  post(
    app: FastifyInstance,
    caller: McpCaller,
    path: string,
    options?: { body?: unknown; idempotencyKey?: string }
  ): Promise<BridgeResponse>;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * A bridge with its own secret: 32 random bytes drawn at construction, held in this closure, never
 * read from configuration or persisted, so two gateway processes (or two app instances) never share
 * one and a restart changes it.
 */
export function createMcpBridge(verifier: OAuthTokenVerifier): McpBridge {
  const secret = randomBytes(32).toString('hex');
  const secretDigest = sha256(secret);

  async function send(
    app: FastifyInstance,
    caller: McpCaller,
    request: {
      method: 'GET' | 'POST';
      url: string;
      body?: unknown;
      headers?: Record<string, string>;
    }
  ): Promise<BridgeResponse> {
    const res = await app.inject({
      // Built from scratch: nothing the client sent is forwarded. The address is the one thing
      // taken from the outer request, so the global rate limit counts this call against the client.
      headers: {
        ...request.headers,
        accept: 'application/json',
        authorization: `Bearer ${caller.token}`,
        [MCP_BRIDGE_HEADER]: secret,
      },
      method: request.method,
      ...(request.body !== undefined ? { payload: request.body as object } : {}),
      remoteAddress: caller.clientIp,
      url: request.url,
    });
    let body: unknown;
    try {
      body = res.payload ? JSON.parse(res.payload) : undefined;
    } catch {
      body = undefined;
    }
    return { body, status: res.statusCode };
  }

  return {
    accepts(headerValue) {
      // A duplicated header reaches Fastify as one comma-joined string or as an array: neither is
      // the secret. Hashing first gives timingSafeEqual equal-length inputs whatever was sent.
      return typeof headerValue === 'string' && timingSafeEqual(sha256(headerValue), secretDigest);
    },
    async get(app, caller, path, query) {
      const url = query && [...query.keys()].length > 0 ? `${path}?${query}` : path;
      return send(app, caller, { method: 'GET', url });
    },
    async post(app, caller, path, options) {
      return send(app, caller, {
        body: options?.body,
        headers: options?.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {},
        method: 'POST',
        url: path,
      });
    },
    async verify(token) {
      try {
        return await verifier.verifyAccessToken(token);
      } catch (err) {
        if (err instanceof OAuthError) {
          return null;
        }
        throw err;
      }
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Set by {@link mcpBridgePlugin}; absent in an app that serves no MCP. */
    mcpBridge?: McpBridge;
  }
}

/**
 * Registers the bridge on the root instance, where `requireAuth` (on every route) and the MCP route
 * can both reach it. Each registration draws a fresh secret.
 */
export const mcpBridgePlugin = fp<{ verifier: OAuthTokenVerifier }>(
  async (app, options) => {
    app.decorate('mcpBridge', createMcpBridge(options.verifier));
  },
  { fastify: '5.x', name: 'mcp-bridge' }
);

const CLIENT_IP_KEY = 'clientIp';

/** The route stamps the client address onto the verified `AuthInfo` before the handler sees it. */
export function withClientIp(authInfo: AuthInfo, clientIp: string): AuthInfo {
  return { ...authInfo, extra: { ...authInfo.extra, [CLIENT_IP_KEY]: clientIp } };
}

/** The caller a verified `AuthInfo` stands for, or null when it lacks what a tool call needs. */
export function callerFromAuthInfo(authInfo: AuthInfo | undefined): McpCaller | null {
  const extra = authInfo?.extra;
  if (!authInfo || !extra) {
    return null;
  }
  const { userId, clientIp } = extra;
  if (typeof userId !== 'string' || typeof clientIp !== 'string') {
    return null;
  }
  return { clientIp, scopes: authInfo.scopes, token: authInfo.token, userId };
}
