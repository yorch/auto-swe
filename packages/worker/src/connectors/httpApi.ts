import {
  type HttpApiConnectionConfig,
  isForbiddenHttpApiHeader,
  isHttpHeaderName,
  isHttpHeaderValue,
  MAX_HTTP_API_DEFAULT_HEADERS,
  parseHttpApiConnectionConfig,
} from '@auto-swe/shared';
import { createGuardedFetch, SsrfBlockedError } from '@auto-swe/shared/lib/guardedDispatcher';
import { ApplicationFailure } from '@temporalio/activity';
import { notSent, notSentRetryable } from '../lib/externalWrite.js';
import { capturingFetch } from '../lib/httpCapture.js';

const HTTP_API_TIMEOUT_MS = 30_000;
/**
 * Temporal payloads are limited (2 MiB hard, 512 KiB warned) and the interpreter carries a node's
 * output forward in history, so a response is read only this far and the *serialised* result is
 * held to the same figure.
 */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** Room above the body cap for the quoting and escaping a serialised string gains. */
const RESULT_HEADROOM = 4096;
const MAX_REQUEST_HEADERS = 20;
const MAX_QUERY_PARAMS = 50;
const MAX_PATH_LENGTH = 2048;
const MAX_QUERY_LENGTH = 1024;
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);
/** Response headers worth returning; everything else (cookies, tokens) is dropped. */
const SAFE_RESPONSE_HEADERS = [
  'content-length',
  'content-type',
  'etag',
  'last-modified',
  'link',
  // A reference to the created resource (`201`). It is returned, never followed: redirects are
  // an error for this connector.
  'location',
  'retry-after',
  'x-request-id',
];

export type HttpApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpApiConnectionLike {
  apiToken: string | null;
  config: HttpApiConnectionConfig;
}

export interface HttpApiRequest {
  body?: unknown;
  headers?: Record<string, string>;
  method: HttpApiMethod;
  /** Absolute path below the connection's `baseUrl`, starting with a single `/`. */
  path: string;
  query?: Record<string, string | number | boolean>;
}

export interface HttpApiResponse {
  body: unknown;
  /** Set to `binary` when the body was not text and is therefore not returned. */
  bodyOmitted?: 'binary';
  headers: Record<string, string>;
  status: number;
  /** True when the body hit the size cap; it is then returned as text, never parsed. */
  truncated?: boolean;
}

/**
 * Turn a non-2xx status into the failure the activity throws.
 *
 * The message names the method, the status and the path only. Never the query string (it may
 * carry a key), the token, or the response body — the far end writes that, it becomes durable
 * failure evidence on the run, and an error page can echo the credential it was sent.
 * 4xx other than 408 and 429 cannot be fixed by sending the same request again.
 */
export function statusFailure(
  service: string,
  method: string,
  path: string,
  status: number
): ApplicationFailure {
  const message = `${service} ${method} ${path} failed (${status})`;
  if (status === 429) {
    // The server declined to process the request, so nothing happened and the ledger may release
    // its claim; Temporal still retries.
    return notSentRetryable(message);
  }
  if (status === 408 || status >= 500) {
    return ApplicationFailure.create({ message, type: `${service}TransientError` });
  }
  return ApplicationFailure.nonRetryable(message, `${service}Error`);
}

/** Read at most {@link MAX_RESPONSE_BYTES} of a response, stopping the stream when it is hit. */
export async function readCappedBody(
  response: Response
): Promise<{ bytes: Buffer; text: string; truncated: boolean }> {
  if (!response.body) {
    return { bytes: Buffer.alloc(0), text: '', truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const room = MAX_RESPONSE_BYTES - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        total += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => undefined);
    }
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, text: bytes.toString('utf8'), truncated };
}

/** Whether a content type carries text a workflow can use (JSON, XML, `text/*`, form data). */
export function isTextContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/x-ndjson' ||
    type === 'application/yaml' ||
    type === 'application/xml' ||
    type === 'application/x-www-form-urlencoded' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  );
}

/**
 * A token as it will sit in a header: printable ASCII, no spaces or controls. Checked before the
 * header is built because undici's header validation error quotes the offending value, and that
 * error would then travel into failure evidence and the HTTP capture log.
 */
export function isUsableTokenValue(token: string): boolean {
  return token.length > 0 && token.length <= 8192 && /^[\x21-\x7e]+$/.test(token);
}

/**
 * A transport failure's name and code only: its message can quote the URL or a header value.
 * undici wraps the useful code (`ECONNREFUSED`, `UND_ERR_*`) in `cause`, so the chain is walked
 * (at most 3 levels) and each level contributes only its name and a code of plain identifier shape.
 */
export function sanitizedCause(err: unknown): { code?: string; name: string }[] {
  const out: { code?: string; name: string }[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current !== null && typeof current === 'object'; depth++) {
    const e = current as { cause?: unknown; code?: unknown; name?: unknown };
    out.push({
      name: typeof e.name === 'string' ? e.name.slice(0, 64) : 'Error',
      ...(typeof e.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.code) ? { code: e.code } : {}),
    });
    current = e.cause;
  }
  return out.length > 0 ? out : [{ name: 'Error' }];
}

/**
 * Whether a transport failure is a name-resolution failure (`ENOTFOUND`, `EAI_AGAIN` on the error
 * or its cause chain, at most 3 levels). Resolution precedes the connection, so nothing was sent.
 */
export function isDnsFailure(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current !== null && typeof current === 'object'; depth++) {
    const e = current as { cause?: unknown; code?: unknown };
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') {
      return true;
    }
    current = e.cause;
  }
  return false;
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType.trim());
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Resolve `path` below `baseUrl` or refuse. Pure; nothing has been sent when it throws. */
export function resolveHttpApiUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean>
): URL {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw notSent('http_api path must be a non-empty string of at most 2048 characters');
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw notSent('http_api path must be an absolute path starting with a single "/"');
  }
  // Every spelling that could make the normalised path leave the prefix is refused before
  // normalising, so the prefix check below is a second line and not the only one.
  if (/[\\?#\s;]/.test(path) || hasControlCharacter(path)) {
    throw notSent(
      'http_api path must not contain backslashes, whitespace, control characters, ";", "?" or "#" ' +
        '(pass a query through `query`)'
    );
  }
  if (/%(?:2e|2f|5c|00|0a|0d|25)/i.test(path)) {
    throw notSent(
      'http_api path must not contain encoded dots, slashes, backslashes, percent signs or controls'
    );
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw notSent('http_api path must not contain "." or ".." segments');
  }

  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const url = new URL(`${prefix}${path}`, base.origin);
  if (url.origin !== base.origin) {
    throw notSent('http_api path resolves outside the connection origin');
  }
  if (prefix !== '' && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    throw notSent('http_api path resolves outside the connection base path');
  }

  if (query) {
    const entries = Object.entries(query);
    if (entries.length > MAX_QUERY_PARAMS) {
      throw notSent(`http_api query may hold at most ${MAX_QUERY_PARAMS} parameters`);
    }
    for (const [key, value] of entries) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw notSent('http_api query values must be strings, numbers or booleans');
      }
      url.searchParams.append(key, String(value));
    }
    if (url.search.length > MAX_QUERY_LENGTH) {
      throw notSent(`http_api query is longer than ${MAX_QUERY_LENGTH} characters`);
    }
  }
  return url;
}

function validatedRequestHeaders(
  headers: Record<string, string> | undefined,
  authHeaderName: string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Object.entries(headers ?? {});
  if (entries.length > MAX_REQUEST_HEADERS) {
    throw notSent(`http_api request may carry at most ${MAX_REQUEST_HEADERS} headers`);
  }
  for (const [name, value] of entries) {
    if (!isHttpHeaderName(name)) {
      throw notSent(`http_api header name "${name.slice(0, 40)}" is not valid`);
    }
    if (isForbiddenHttpApiHeader(name) || name.toLowerCase() === authHeaderName?.toLowerCase()) {
      throw notSent(`http_api header ${name} may not be set on a request`);
    }
    if (typeof value !== 'string' || !isHttpHeaderValue(value)) {
      throw notSent(`http_api header ${name} has an invalid value`);
    }
    out[name.toLowerCase()] = value;
  }
  return out;
}

function authHeaders(
  config: HttpApiConnectionConfig,
  apiToken: string | null
): Record<string, string> {
  const authType = config.authType ?? 'bearer';
  if (authType === 'none') {
    return {};
  }
  if (!apiToken) {
    throw notSent(`http_api connection uses ${authType} auth but has no API token stored`);
  }
  // `basic` is base64-encoded, so any password is safe in a header; the other two carry the raw
  // value.
  if (authType !== 'basic' && !isUsableTokenValue(apiToken)) {
    // Never echoes the token.
    throw notSent(`http_api connection's API token is not a valid ${authType} credential`);
  }
  if (authType === 'bearer') {
    return { authorization: `Bearer ${apiToken}` };
  }
  if (authType === 'basic') {
    const user = config.basicUsername ?? '';
    return { authorization: `Basic ${Buffer.from(`${user}:${apiToken}`).toString('base64')}` };
  }
  // `header`: the schema guarantees a name; check again in case a stored row predates it.
  if (!config.authHeaderName) {
    throw notSent('http_api connection uses header auth but has no authHeaderName');
  }
  return { [config.authHeaderName.toLowerCase()]: apiToken };
}

function encodeBody(
  method: string,
  body: unknown,
  headers: Record<string, string>
): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (!METHODS_WITH_BODY.has(method)) {
    throw notSent(`http_api ${method} requests cannot carry a body`);
  }
  if (typeof body === 'string') {
    headers['content-type'] ??= 'text/plain; charset=utf-8';
    return body;
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(body);
  } catch {
    throw notSent('http_api body is not JSON-serialisable');
  }
  if (encoded === undefined) {
    throw notSent('http_api body is not JSON-serialisable');
  }
  headers['content-type'] ??= 'application/json';
  return encoded;
}

/**
 * Send one request to a generic HTTP API connection.
 *
 * Every validation failure is a {@link notSent} refusal raised before any network I/O, so the
 * outcome ledger can release its claim. The destination is the operator-supplied `baseUrl`, so
 * the transport is the guarded fetch with no private-network opt-in; redirects are refused.
 */
export async function httpApiRequest(
  conn: HttpApiConnectionLike,
  req: HttpApiRequest,
  opts: { signal?: AbortSignal } = {}
): Promise<HttpApiResponse> {
  // Re-validate: the row's config is editable data, and the worker must not trust that the
  // gateway's check ran on every writer.
  const parsed = parseHttpApiConnectionConfig(conn.config);
  if (!parsed.ok) {
    throw notSent(`http_api connection config is invalid: ${parsed.reason}`);
  }
  const config = parsed.config;

  const method = String(req.method).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw notSent(`http_api method ${String(req.method).slice(0, 16)} is not supported`);
  }
  const url = resolveHttpApiUrl(config.baseUrl, req.path, req.query);
  const callerHeaders = validatedRequestHeaders(req.headers, config.authHeaderName);

  const defaults: Record<string, string> = {};
  const defaultEntries = Object.entries(config.defaultHeaders ?? {});
  if (defaultEntries.length > MAX_HTTP_API_DEFAULT_HEADERS) {
    throw notSent('http_api connection has too many default headers');
  }
  for (const [name, value] of defaultEntries) {
    defaults[name.toLowerCase()] = value;
  }

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
    ...defaults,
    ...callerHeaders,
    ...authHeaders(config, conn.apiToken),
  };
  const body = encodeBody(method, req.body, headers);

  const timeoutSignal = AbortSignal.timeout(HTTP_API_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
  const path = url.pathname;

  let response: Response;
  try {
    // A redirect is an error: the request is never followed to a host the credential was not
    // saved for, and a redirecting endpoint costs this activity's retries and then fails.
    response = await capturingFetch(createGuardedFetch({ allowPrivate: false }), 'connector')(
      url.href,
      { body, headers, method, redirect: 'error', signal }
    );
  } catch (err) {
    if (opts.signal?.aborted) {
      throw err;
    }
    if (err instanceof SsrfBlockedError) {
      // Raised by the guarded lookup before any connection, so nothing was sent. A resolution
      // failure may pass on its own and is retried; every other refusal is permanent. The text is
      // fixed: the error names the host.
      throw err.reason === 'unresolvable'
        ? notSentRetryable(`HttpApi ${method} ${path} failed: the host could not be resolved`)
        : notSent(`HttpApi ${method} ${path} refused: the destination is not permitted`);
    }
    // Retryable, and worded without the URL: a transport error can carry the query string. Its
    // own message is not attached as the cause: it can quote a header value.
    throw ApplicationFailure.create({
      cause: ApplicationFailure.create({
        message: JSON.stringify(sanitizedCause(err)),
        nonRetryable: false,
        type: 'TransportError',
      }),
      message: `HttpApi ${method} ${path} failed: the request did not complete`,
      type: 'HttpApiNetworkError',
    });
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw statusFailure('HttpApi', method, path, response.status);
  }

  const outHeaders: Record<string, string> = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) {
      outHeaders[name] = value.slice(0, 1024);
    }
  }
  const contentType = response.headers.get('content-type');
  const { bytes, text, truncated } = await readCappedBody(response);
  if (bytes.length > 0 && !isTextContentType(contentType)) {
    return {
      body: null,
      bodyOmitted: 'binary',
      headers: outHeaders,
      status: response.status,
      ...(truncated ? { truncated: true } : {}),
    };
  }
  let parsedBody: unknown = text === '' ? null : text;
  if (!truncated && text !== '' && isJsonContentType(contentType)) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }
  let capped = truncated;
  // A control-heavy text can serialise several times larger than it reads; hold the result, not
  // just the input, to the cap.
  if (Buffer.byteLength(JSON.stringify(parsedBody) ?? '') > MAX_RESPONSE_BYTES + RESULT_HEADROOM) {
    parsedBody = text.slice(0, Math.floor(MAX_RESPONSE_BYTES / 8));
    capped = true;
  }
  const result: HttpApiResponse = {
    body: parsedBody,
    headers: outHeaders,
    status: response.status,
  };
  if (capped) {
    result.truncated = true;
  }
  return result;
}
