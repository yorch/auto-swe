/**
 * Fixed parameters of the OAuth 2.1 authorization server that MCP clients use.
 *
 * Everything derives from the deployment's public base URL, so there is nothing
 * to configure and nothing to read from the database at boot: the authorization
 * server is configured once in `buildAuth()`, and the operator-facing switches
 * (`mcp.enabled`, `mcp.writeToolsEnabled`) are read per request by the gate.
 */

/** The only scopes the server knows. `mcp:write` implies `mcp:read`. */
export const MCP_SCOPE_READ = 'mcp:read';
export const MCP_SCOPE_WRITE = 'mcp:write';
export const MCP_SCOPE_OFFLINE = 'offline_access';
export const MCP_SCOPES = [MCP_SCOPE_READ, MCP_SCOPE_WRITE, MCP_SCOPE_OFFLINE] as const;

/** Short-lived on purpose: revocation also bites at the resource server, but this bounds a leak. */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 600;
/** Refresh tokens rotate on use; a connection that goes unused this long must be re-authorised. */
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 3600;

/**
 * Signing-key lifecycle for the `jwt` plugin. A key signs for
 * `MCP_JWKS_ROTATION_SECONDS`, then stays published for the grace period so a
 * token signed in its last moments still verifies. The grace covers the access
 * token lifetime plus clock skew plus a resource server's JWKS cache.
 */
export const MCP_JWKS_ROTATION_SECONDS = 30 * 24 * 3600;
export const MCP_JWKS_GRACE_SECONDS = 3600;

/** Where the authorization server's endpoints live (better-auth's default base path). */
export const AUTH_BASE_PATH = '/api/auth';

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The issuer (`iss`) of every token and of the discovery document. */
export function mcpIssuerFor(baseUrl: string): string {
  return `${trimTrailingSlashes(baseUrl)}${AUTH_BASE_PATH}`;
}

/** The RFC 8707 resource indicator, and so the `aud` of every access token. */
export function mcpResourceFor(baseUrl: string): string {
  return `${trimTrailingSlashes(baseUrl)}/api/v1/mcp`;
}
