import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { isCanonicalRequestPath } from './canonicalPath.js';
import { AUTH_BASE_PATH, MCP_SCOPE_WRITE } from './mcpOAuth.js';

/**
 * Policy for the OAuth authorization server that MCP clients use.
 *
 * Everything about *whether and how* the better-auth OAuth endpoints may be
 * used lives here, in one Fastify plugin, rather than in better-auth hooks:
 * it is deterministic, it reads the current settings on every request, and it
 * does not depend on better-auth's hook path matching (the plugin's `continue`
 * endpoint calls `authorize` internally, which a path-matched hook would miss).
 *
 * The plugin registers `onRequest` and `preHandler` hooks app-wide and acts only
 * on `/api/auth` paths, so it must be registered before the routes it guards.
 *
 *  - `onRequest` classifies the path: non-canonical spellings are refused, every
 *    OAuth path outside the allowlist is 404, and the allowlisted ones are 404
 *    while `mcp.enabled` is off.
 *  - `preHandler` (the body is parsed by then) applies the per-endpoint rules:
 *    the audience and scope an authorization may ask for, who may authorize, and
 *    what a client may register.
 */

export interface McpGateSettings {
  enabled: boolean;
  writeToolsEnabled: boolean;
}

export interface McpOAuthGateOptions {
  /** The RFC 8707 resource identifier: the only audience a token may be requested for. */
  resource: string;
  /** Read per request (through the settings cache); an error fails closed. */
  getSettings: () => Promise<McpGateSettings>;
  /** The better-auth session behind the request's cookie, or null when there is none. */
  getSessionUser: (request: FastifyRequest) => Promise<{ isActive: boolean } | null>;
  /** The RFC 8414 document handler (`oauthProviderAuthServerMetadata(auth)`). */
  authServerMetadata: (request: Request) => Promise<Response>;
}

/** The OAuth endpoints (and discovery documents) that may be served, by exact path. */
const AUTHORIZE = `${AUTH_BASE_PATH}/oauth2/authorize`;
const CONSENT = `${AUTH_BASE_PATH}/oauth2/consent`;
const CONTINUE = `${AUTH_BASE_PATH}/oauth2/continue`;
const TOKEN = `${AUTH_BASE_PATH}/oauth2/token`;
const REGISTER = `${AUTH_BASE_PATH}/oauth2/register`;
const ALLOWED_PATHS: ReadonlySet<string> = new Set([
  AUTHORIZE,
  CONSENT,
  CONTINUE,
  TOKEN,
  REGISTER,
  `${AUTH_BASE_PATH}/oauth2/revoke`,
  `${AUTH_BASE_PATH}/oauth2/public-client`,
  `${AUTH_BASE_PATH}/.well-known/oauth-authorization-server`,
  `${AUTH_BASE_PATH}/jwks`,
]);

/**
 * Path prefixes (after the auth base path, folded) that belong to the OAuth provider and
 * its signing-key plugin. Anything here that is not in `ALLOWED_PATHS` is 404:
 * client management, `get-consents`/`delete-consent`/`update-consent`, `introspect`,
 * `userinfo`, `end-session`, the admin resource endpoints, the OIDC discovery document,
 * and `GET /token`, the jwt plugin's session-to-JWT minting endpoint.
 */
const OAUTH_NAMESPACES = ['/oauth2', '/admin/oauth2', '/.well-known', '/jwks', '/token'];

/** How an OAuth endpoint reports an error (RFC 6749 section 5.2). */
function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply
    .status(status)
    .header('cache-control', 'no-store')
    .send({ error, error_description: description });
}

function notFound(reply: FastifyReply) {
  return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
}

function rawPath(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/**
 * The most generous reading of a path: percent-decoded, lower-cased, repeated and
 * trailing slashes dropped. Matching is done on this form so an unusual spelling can
 * never *escape* a rule; serving is done on the exact path, so it can never *reach*
 * an endpoint the allowlist does not name.
 */
function foldPath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // An undecodable path is matched as written; the canonical-form check refuses it anyway.
  }
  return decoded
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

function isOAuthNamespace(rel: string): boolean {
  return OAUTH_NAMESPACES.some((ns) => rel === ns || rel.startsWith(`${ns}/`));
}

type FormBody = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Query-string parameters plus any urlencoded body fields: what `authorize` and `token` read. */
function requestParams(request: FastifyRequest): URLSearchParams {
  const query = request.url.indexOf('?');
  const params = new URLSearchParams(query === -1 ? '' : request.url.slice(query + 1));
  if (isRecord(request.body)) {
    for (const [key, value] of Object.entries(request.body)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        if (typeof one === 'string') {
          params.append(key, one);
        }
      }
    }
  }
  return params;
}

function isLoopbackHttp(uri: URL): boolean {
  return uri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname);
}

/** `native` fits a client whose every redirect is loopback or a private-use scheme. */
function looksNative(redirectUris: unknown): boolean {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return false;
  }
  return redirectUris.every((raw) => {
    try {
      const uri = new URL(String(raw));
      return isLoopbackHttp(uri) || (uri.protocol !== 'http:' && uri.protocol !== 'https:');
    } catch {
      return false;
    }
  });
}

export const mcpOAuthGate = fp<McpOAuthGateOptions>(
  async (app: FastifyInstance, options) => {
    const { resource } = options;
    const settingsByRequest = new WeakMap<FastifyRequest, McpGateSettings>();

    /** Reads the settings; a failure answers 503 rather than guessing a policy. */
    async function loadSettings(
      request: FastifyRequest,
      reply: FastifyReply
    ): Promise<McpGateSettings | null> {
      try {
        const settings = await options.getSettings();
        settingsByRequest.set(request, settings);
        return settings;
      } catch (err) {
        request.log.error({ err }, 'mcp oauth gate: could not read settings');
        await oauthError(reply, 503, 'temporarily_unavailable', 'Try again shortly');
        return null;
      }
    }

    app.addHook('onRequest', async (request, reply) => {
      const raw = rawPath(request.url);
      const folded = foldPath(raw);
      if (folded !== AUTH_BASE_PATH && !folded.startsWith(`${AUTH_BASE_PATH}/`)) {
        return;
      }
      // Rules below match on the path better-auth will serve, so a path that
      // resolves to something else is refused before any rule runs.
      if (!isCanonicalRequestPath(request.url)) {
        return reply.status(400).send({
          error: { code: 'NON_CANONICAL_PATH', message: 'Request path is not in canonical form' },
        });
      }
      const rel = folded.slice(AUTH_BASE_PATH.length);
      if (!isOAuthNamespace(rel)) {
        return;
      }
      if (!ALLOWED_PATHS.has(raw)) {
        return notFound(reply);
      }
      const settings = await loadSettings(request, reply);
      if (!settings) {
        return reply;
      }
      if (!settings.enabled) {
        return notFound(reply);
      }
    });

    app.addHook('preHandler', async (request, reply) => {
      const settings = settingsByRequest.get(request);
      if (!settings) {
        return;
      }
      const path = rawPath(request.url);
      if (path === REGISTER) {
        return hardenRegistration(request, reply);
      }
      if (path === TOKEN) {
        return checkResources(reply, requestParams(request), { required: false });
      }
      if (path === AUTHORIZE || path === CONSENT || path === CONTINUE) {
        return checkAuthorization(request, reply, path, settings);
      }
    });

    /** `resource` must be present (when required) and must always be the MCP resource. */
    function checkResources(
      reply: FastifyReply,
      params: URLSearchParams,
      { required }: { required: boolean }
    ) {
      const resources = params.getAll('resource');
      if (resources.length === 0 && required) {
        return oauthError(
          reply,
          400,
          'invalid_target',
          'A resource parameter naming the MCP server is required'
        );
      }
      if (resources.some((value) => value !== resource)) {
        return oauthError(
          reply,
          400,
          'invalid_target',
          'This authorization server issues tokens for the MCP server only'
        );
      }
    }

    function checkScope(
      reply: FastifyReply,
      scope: string | null,
      settings: McpGateSettings,
      { required }: { required: boolean }
    ) {
      if (settings.writeToolsEnabled) {
        return;
      }
      // Without a `scope` the plugin grants the client's registered scopes, which for a
      // registration that listed `mcp:write` includes it. While writes are off there is
      // no way to say "everything but write" without a database read, so ask for a scope.
      if (scope === null && required) {
        return oauthError(reply, 400, 'invalid_scope', 'A scope parameter is required');
      }
      if (scope?.split(' ').includes(MCP_SCOPE_WRITE)) {
        return oauthError(reply, 400, 'invalid_scope', 'Write access is not enabled');
      }
    }

    async function checkAuthorization(
      request: FastifyRequest,
      reply: FastifyReply,
      path: string,
      settings: McpGateSettings
    ) {
      // Who authorizes: an inactive account sits in the approval queue and may not grant
      // anything. No session is fine here: the plugin sends the browser to the login page.
      const session = await options.getSessionUser(request);
      if (session && !session.isActive) {
        return oauthError(reply, 403, 'access_denied', 'This account is not active');
      }
      if (path === AUTHORIZE) {
        const params = requestParams(request);
        return (
          checkResources(reply, params, { required: true }) ??
          checkScope(reply, params.get('scope'), settings, { required: true })
        );
      }
      // consent / continue carry the original authorization request, signed, as `oauth_query`.
      const body = isRecord(request.body) ? (request.body as FormBody) : {};
      const original = typeof body.oauth_query === 'string' ? body.oauth_query : null;
      if (original !== null) {
        const params = new URLSearchParams(original);
        const refused =
          checkResources(reply, params, { required: true }) ??
          checkScope(reply, params.get('scope'), settings, { required: false });
        if (refused) {
          return refused;
        }
      }
      // The scope the user narrows the grant to (consent only).
      if (typeof body.scope === 'string') {
        return checkScope(reply, body.scope, settings, { required: false });
      }
    }

    /**
     * Anonymous registration is an open write endpoint, so the registration is forced
     * into the narrowest shape the plugin supports: a public client with no callbacks the
     * server would call.
     */
    function hardenRegistration(request: FastifyRequest, reply: FastifyReply) {
      const body = request.body;
      if (!isRecord(body)) {
        return; // the plugin answers a malformed body itself
      }
      const method = body.token_endpoint_auth_method;
      if (method === undefined) {
        body.token_endpoint_auth_method = 'none';
      } else if (method !== 'none') {
        return oauthError(
          reply,
          400,
          'invalid_client_metadata',
          'Only public clients (token_endpoint_auth_method "none") may register'
        );
      }
      // The server would POST to this on sign-out; the plugin only checks the host name
      // against a private-address list, which a DNS answer can sidestep.
      if (
        body.backchannel_logout_uri !== undefined ||
        body.backchannel_logout_session_required !== undefined
      ) {
        return oauthError(
          reply,
          400,
          'invalid_client_metadata',
          'Back-channel logout is not supported'
        );
      }
      // The plugin defaults `application_type` to `web`, which refuses loopback `http`
      // redirects; clients built on the 1.x MCP SDK send none, so they would fail to register.
      if (body.application_type === undefined && looksNative(body.redirect_uris)) {
        body.application_type = 'native';
      }
    }

    // RFC 8414 discovery for an issuer with a path: the well-known segment goes between
    // the host and the issuer's path. Mounted at the root, where better-auth cannot.
    app.get(`/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`, async (request, reply) => {
      const settings = await loadSettings(request, reply);
      if (!settings) {
        return reply;
      }
      if (!settings.enabled) {
        return notFound(reply);
      }
      const response = await options.authServerMetadata(
        new Request(`http://${request.headers.host}${request.url}`, {
          headers: fromNodeHeaders(request.headers),
        })
      );
      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });
      return reply.send(await response.text());
    });
  },
  { fastify: '5.x', name: 'mcp-oauth-gate' }
);
