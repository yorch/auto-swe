import { decryptSecret, encryptSecret } from './crypto.js';

/**
 * Custom request headers for an `mcp` Connection (an API gateway key, a tenant id, a vendor
 * header). They are secrets by default: stored as one AES-256-GCM envelope in the Connection's
 * `headers*` columns, write-only through the API (responses and the audit trail carry names only),
 * and sent only to the connection's own origin.
 *
 * `Authorization` is deliberately not a custom header: the connection's bearer token is the one
 * place a credential for it lives, so there is a single stored secret to rotate, redact and clear.
 */

export interface McpHeader {
  name: string;
  value: string;
}

export const MAX_MCP_HEADERS = 5;
const MAX_VALUE_LENGTH = 2048;

/** RFC 7230 `token`: the characters a header name may hold. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Visible ASCII plus inner spaces, so a pasted newline cannot smuggle in a second header. */
const VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

/**
 * Names a connection may not set. Hop-by-hop headers (RFC 7230 §6.1) describe one connection and
 * must not be forwarded; the rest are owned by the transport or by the bearer token, and a custom
 * value would break the protocol or smuggle a credential past the token's origin handling.
 */
const FORBIDDEN_NAMES = new Set([
  'authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-type',
  'accept',
  'cookie',
  'set-cookie',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

/** Why a header name is not allowed, or null when it is. Case-insensitive. */
export function headerNameProblem(name: string): string | null {
  if (name.length === 0 || name.length > 100 || !TOKEN.test(name)) {
    return `'${name.slice(0, 40)}' is not a valid header name`;
  }
  const lower = name.toLowerCase();
  if (lower.startsWith('proxy-') || FORBIDDEN_NAMES.has(lower)) {
    return lower === 'authorization'
      ? 'Use the bearer token field instead of an Authorization header'
      : `The ${name} header is set by the connection itself and cannot be customised`;
  }
  return null;
}

/** The first problem with a full header set, or null. Names are unique case-insensitively. */
export function validateMcpHeaders(headers: readonly McpHeader[]): string | null {
  if (headers.length > MAX_MCP_HEADERS) {
    return `A connection can carry at most ${MAX_MCP_HEADERS} custom headers`;
  }
  const seen = new Set<string>();
  for (const h of headers) {
    const problem = headerNameProblem(h.name);
    if (problem) {
      return problem;
    }
    if (seen.has(h.name.toLowerCase())) {
      return `The ${h.name} header is listed more than once`;
    }
    seen.add(h.name.toLowerCase());
    if (h.value.length > MAX_VALUE_LENGTH || !VALUE.test(h.value)) {
      return `The value of ${h.name} must be visible characters with no line breaks`;
    }
  }
  return null;
}

/** The Connection columns holding the sealed header set. */
export function sealMcpHeaders(headers: readonly McpHeader[]) {
  const enc = encryptSecret(JSON.stringify(headers));
  return {
    headersAuthTag: enc.authTag,
    headersCiphertext: enc.ciphertext,
    headersKeyVersion: enc.keyVersion,
    headersNonce: enc.nonce,
  };
}

export const NO_HEADER_COLUMNS = {
  headersAuthTag: null,
  headersCiphertext: null,
  headersNonce: null,
};

interface HeaderColumns {
  headersCiphertext?: Uint8Array | null;
  headersNonce?: Uint8Array | null;
  headersAuthTag?: Uint8Array | null;
  headersKeyVersion?: number;
}

/**
 * Opens a stored header set. Returns `[]` when none is stored; THROWS when the envelope cannot be
 * read or holds something other than a header list, so a caller never proceeds as if the headers
 * the server expects were simply absent. The thrown message is fixed: it is the crypto layer's
 * text otherwise.
 */
export function openMcpHeaders(row: HeaderColumns): McpHeader[] {
  if (!(row.headersCiphertext && row.headersNonce && row.headersAuthTag)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      decryptSecret({
        authTag: row.headersAuthTag,
        ciphertext: row.headersCiphertext,
        keyVersion: row.headersKeyVersion ?? 1,
        nonce: row.headersNonce,
      })
    );
  } catch {
    throw new Error('stored MCP headers cannot be read');
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (h) =>
        typeof h === 'object' &&
        h !== null &&
        typeof (h as McpHeader).name === 'string' &&
        typeof (h as McpHeader).value === 'string'
    )
  ) {
    throw new Error('stored MCP headers cannot be read');
  }
  // Re-validated on the way out: a row written by anything but the gateway route must not be
  // able to put a forbidden header on the wire.
  const headers = parsed as McpHeader[];
  if (validateMcpHeaders(headers)) {
    throw new Error('stored MCP headers cannot be read');
  }
  return headers;
}

/**
 * Applies a connection's custom headers to a request's headers when the request targets the
 * connection's own origin, and removes them otherwise (a transport pointed elsewhere carries no
 * credential). Names the transport owns are never overwritten.
 */
export function applyMcpHeaders(
  target: URL,
  serverOrigin: string,
  headers: Headers,
  custom: readonly McpHeader[]
): void {
  for (const h of custom) {
    if (target.origin === serverOrigin) {
      if (!headers.has(h.name)) {
        headers.set(h.name, h.value);
      }
    } else {
      headers.delete(h.name);
    }
  }
}
