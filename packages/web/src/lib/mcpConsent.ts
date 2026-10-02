import { signedOAuthQuery } from './oauthQuery';

/** What an MCP client may be granted; the same names the gateway's OAuth server uses. */
export const MCP_SCOPE_READ = 'mcp:read';
export const MCP_SCOPE_WRITE = 'mcp:write';
export const MCP_SCOPE_OFFLINE = 'offline_access';

/** How long a connection survives without being used (the gateway's refresh-token lifetime). */
export const MCP_CONNECTION_DAYS = 14;

export interface ConsentRequest {
  clientId: string;
  /** The signed query to send back with the decision. */
  oauthQuery: string;
  redirectUri: string;
  scopes: string[];
}

/**
 * The authorization request the consent page was opened for, read from its address. Null
 * when the page was opened without one (a bookmark, a hand-typed URL, a link that lost its
 * signature): there is nothing to decide, and the page says so.
 */
export function parseConsentRequest(search: string): ConsentRequest | null {
  const params = new URLSearchParams(search);
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const oauthQuery = signedOAuthQuery(search);
  if (!(clientId && redirectUri && oauthQuery)) {
    return null;
  }
  const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
  return { clientId, oauthQuery, redirectUri, scopes };
}

export interface RedirectDisplay {
  /** Where the user will be sent, as it should be shown: the host, never the path or query. */
  host: string;
  /**
   * The redirect stays on this machine: a loopback address or an app's own URL scheme. Any
   * program on the machine can listen on such an address, so the page warns about it.
   */
  local: boolean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function describeRedirect(uri: string): RedirectDisplay {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { host: uri, local: false };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return {
      host: url.host,
      local: url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname),
    };
  }
  return { host: `${url.protocol}//${url.host}`, local: true };
}

/**
 * Where the authorization server says to go next: the consent page, or the client's own
 * redirect (an authorization code, or an error). It comes from the gateway, but a value that
 * would run script is never navigated to.
 */
export function resumeUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const { protocol } = new URL(value);
    return ['javascript:', 'data:', 'vbscript:', 'blob:', 'file:'].includes(protocol)
      ? null
      : value;
  } catch {
    return null;
  }
}

/** The scopes to grant: everything requested, except write unless the user allowed it. */
export function grantedScopes(requested: readonly string[], allowWrite: boolean): string[] {
  return requested.filter((scope) => scope !== MCP_SCOPE_WRITE || allowWrite);
}
