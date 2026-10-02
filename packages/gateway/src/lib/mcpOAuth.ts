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

/**
 * How long a resource server may keep the published signing keys before re-reading them.
 * A key that is rotated out stays published for `MCP_JWKS_GRACE_SECONDS`, which has to cover
 * this, the access-token lifetime and clock skew; a token signed by a key the cache has not
 * seen yet is handled by a refresh on the unknown `kid`, not by waiting.
 */
export const MCP_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
/** Floor between two forced JWKS reads, so a stream of random `kid`s cannot turn into a stream of reads. */
export const MCP_JWKS_MIN_REFRESH_MS = 10_000;
/**
 * A consent row and the token issued under it are stamped by (possibly) different replicas, so
 * a token may carry an `iat` slightly earlier than the consent it was issued under.
 */
export const MCP_CONSENT_SKEW_SECONDS = 5;

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

/** What a token may be issued under right now. */
export interface McpIssuanceState {
  enabled: boolean;
  writeToolsEnabled: boolean;
}

/**
 * Why a token must not be issued, or null when it may be.
 *
 * Authorization can be completed on paths the gate never sees (the plugin resumes it from
 * the sign-in response), so the rules that bound a grant are also checked where every
 * access token is minted, on the code and the refresh grant alike: the account is active,
 * MCP is on, and `mcp:write` is held only while writes are enabled.
 */
export function mcpIssuanceRefusal(
  user: Record<string, unknown> | null | undefined,
  scopes: readonly string[],
  state: McpIssuanceState
): string | null {
  if (!state.enabled) {
    return 'MCP access is not enabled';
  }
  if (user?.isActive !== true) {
    return 'This account is not active';
  }
  if (!state.writeToolsEnabled && scopes.includes(MCP_SCOPE_WRITE)) {
    return 'Write access is not enabled';
  }
  return null;
}
