import { z } from 'zod';
import { isCanonicalRequestPath } from './canonicalPath.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { checkProbeUrl } from './ssrfGuard.js';
import { generateWebhookSigningSecret } from './webhookSigning.js';

/**
 * Run callbacks (docs/run-callbacks.md): a service that starts a run names a
 * URL, and the platform POSTs a signed JSON body there when the run waits for a
 * human and when it ends, instead of the service polling.
 *
 * Everything here is pure apart from the AES-GCM envelope helpers: URL rules,
 * the endpoint secret columns, the payload shape and the retry schedule. The
 * gateway applies the URL rules at save and at launch; the worker applies them
 * again before every send, because an endpoint can be edited after a launch
 * named a URL under it.
 */

/** The events a callback endpoint may subscribe to. */
export const CALLBACK_EVENT_TYPES = ['run.completed', 'run.waiting_for_human'] as const;
export type CallbackEventType = (typeof CALLBACK_EVENT_TYPES)[number];

/** `X-AutoSwe-Event`: the event type, so a receiver can route before parsing. */
export const CALLBACK_EVENT_HEADER = 'X-AutoSwe-Event';
/**
 * `X-AutoSwe-Delivery`: the delivery id, stable across retries and redeliveries.
 * A receiver dedupes on it; the platform's own inbound endpoints refuse a
 * request carrying it, so a callback pointed back at the platform cannot loop.
 */
export const CALLBACK_DELIVERY_HEADER = 'X-AutoSwe-Delivery';

/** The caller's opaque `context`, serialised, may be at most this many bytes. */
export const CALLBACK_CONTEXT_MAX_BYTES = 1024;
/** Longest callback URL accepted. */
export const CALLBACK_URL_MAX_LENGTH = 2048;
/** Longest endpoint path prefix accepted. */
export const CALLBACK_PATH_PREFIX_MAX_LENGTH = 512;
/** How long the secret a rotation replaced still signs deliveries (as a second `v1`). */
export const CALLBACK_SECRET_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** The optional `callback` object of a launch body. */
export const CallbackRequestSchema = z
  .object({
    /** Opaque, echoed back in every payload. At most 1 KB serialised. */
    context: z.unknown().optional(),
    /** A registered endpoint, used as is: its origin and path prefix. */
    endpointId: z.string().uuid().optional(),
    /** A full URL under a registered endpoint; its query may carry a receiver token. */
    url: z.string().min(1).max(CALLBACK_URL_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.endpointId === undefined) === (value.url === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'callback needs exactly one of endpointId or url',
        path: [],
      });
    }
    if (value.context !== undefined && callbackContextBytes(value.context) === null) {
      ctx.addIssue({
        code: 'custom',
        message: `callback.context must be JSON of at most ${CALLBACK_CONTEXT_MAX_BYTES} bytes`,
        path: ['context'],
      });
    }
  });
export type CallbackRequest = z.infer<typeof CallbackRequestSchema>;

/** Serialised size of `context`, or null when it is not JSON or is over the limit. */
export function callbackContextBytes(context: unknown): number | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(context);
  } catch {
    return null;
  }
  if (text === undefined) {
    return null;
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  return bytes <= CALLBACK_CONTEXT_MAX_BYTES ? bytes : null;
}

export type CallbackUrlRefusal = { ok: false; code: string; reason: string };

/**
 * Control characters, whitespace and the backslash (which the URL standard reads
 * as `/` in an http(s) URL, so it would let a path say one thing and mean another).
 */
function hasUnsafeChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) {
      return true;
    }
  }
  return false;
}
// An encoded `.`, `/` or `\`: a receiver that decodes before routing would read a different path
// than the one matched against the prefix.
const ENCODED_SEPARATOR_RE = /%(2e|2f|5c)/i;

/** Rules a path (prefix or URL path) must meet; null when it meets them. */
function pathRefusal(path: string): string | null {
  if (!path.startsWith('/')) {
    return 'the path must start with /';
  }
  if (hasUnsafeChar(path)) {
    return 'the path contains whitespace, a control character or a backslash';
  }
  if (ENCODED_SEPARATOR_RE.test(path)) {
    return 'the path contains an encoded ".", "/" or "\\"';
  }
  if (path.includes('?') || path.includes('#')) {
    return 'the path may not contain ? or #';
  }
  // `/hooks/../admin` and its relatives: refuse what URL resolution would rewrite.
  if (!isCanonicalRequestPath(path)) {
    return 'the path contains "." or ".." segments';
  }
  return null;
}

/**
 * An endpoint origin as stored: the URL standard's origin (scheme, lowercase
 * host, port with the default elided). https only, unless the endpoint opts in
 * to a private network, which also permits http. The SSRF text guard runs here
 * with the same opt-in; loopback, link-local and metadata hosts are refused
 * whatever the opt-in says.
 */
export function normaliseCallbackOrigin(
  raw: string,
  allowPrivateNetwork: boolean
): { ok: true; origin: string } | CallbackUrlRefusal {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { code: 'INVALID_ORIGIN', ok: false, reason: 'the origin is not a URL' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowPrivateNetwork)) {
    return {
      code: 'INVALID_ORIGIN',
      ok: false,
      reason: allowPrivateNetwork
        ? 'the origin must be http or https'
        : 'the origin must be https (http only with the private-network option)',
    };
  }
  if (url.username || url.password || (splitAuthority(text)?.authority ?? '').includes('@')) {
    return { code: 'INVALID_ORIGIN', ok: false, reason: 'the origin may not carry credentials' };
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || text.includes('#')) {
    return {
      code: 'INVALID_ORIGIN',
      ok: false,
      reason: 'the origin is scheme, host and port only; put a path in the path prefix',
    };
  }
  const guard = checkProbeUrl(url.origin, { allowPrivate: allowPrivateNetwork });
  if (!guard.ok) {
    return { code: 'BASE_URL_REFUSED', ok: false, reason: guard.reason };
  }
  return { ok: true, origin: url.origin };
}

/** A path prefix as stored: canonical, absolute, no query or fragment. Empty means `/`. */
export function normaliseCallbackPathPrefix(
  raw: string | undefined
): { ok: true; pathPrefix: string } | CallbackUrlRefusal {
  const prefix = raw === undefined || raw === '' ? '/' : raw;
  if (prefix.length > CALLBACK_PATH_PREFIX_MAX_LENGTH) {
    return { code: 'INVALID_PATH_PREFIX', ok: false, reason: 'the path prefix is too long' };
  }
  const refusal = pathRefusal(prefix);
  return refusal
    ? { code: 'INVALID_PATH_PREFIX', ok: false, reason: refusal }
    : { ok: true, pathPrefix: prefix };
}

/** An absolute URL's authority as written (before any parsing) and the text after it, or null. */
function splitAuthority(raw: string): { authority: string; rest: string } | null {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(raw);
  return m ? { authority: m[1] ?? '', rest: raw.slice(m[0].length) } : null;
}

export interface ParsedCallbackUrl {
  url: URL;
  origin: string;
  path: string;
  /** Origin and path: what logs, history and the UI show. Never the query. */
  target: string;
}

/**
 * A callback URL a launch named. No credentials in the authority, no fragment,
 * a canonical path (no dot segments, encoded or not, and no encoded separators),
 * http(s) only. The query is kept: it may carry the receiver's own token.
 */
export function parseCallbackUrl(
  raw: string
): { ok: true; value: ParsedCallbackUrl } | CallbackUrlRefusal {
  const refuse = (reason: string): CallbackUrlRefusal => ({
    code: 'INVALID_CALLBACK_URL',
    ok: false,
    reason,
  });
  if (raw.length > CALLBACK_URL_MAX_LENGTH) {
    return refuse('the URL is too long');
  }
  if (hasUnsafeChar(raw)) {
    return refuse('the URL contains whitespace, a control character or a backslash');
  }
  if (raw.includes('#')) {
    return refuse('the URL may not carry a fragment');
  }
  const split = splitAuthority(raw);
  if (split === null) {
    return refuse('the URL must be absolute');
  }
  if (split.authority.includes('@')) {
    return refuse('the URL may not carry credentials');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('the URL does not parse');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return refuse('the URL must be http or https');
  }
  if (url.username || url.password) {
    return refuse('the URL may not carry credentials');
  }
  const query = split.rest.indexOf('?');
  const rawPath = (query === -1 ? split.rest : split.rest.slice(0, query)) || '/';
  const refusal = pathRefusal(rawPath);
  if (refusal) {
    return refuse(refusal);
  }
  return {
    ok: true,
    value: { origin: url.origin, path: url.pathname, target: `${url.origin}${url.pathname}`, url },
  };
}

/** Whether `path` is the prefix itself or under it on a segment boundary. */
export function pathUnderPrefix(path: string, prefix: string): boolean {
  if (prefix === '/') {
    return path.startsWith('/');
  }
  if (prefix.endsWith('/')) {
    return path.startsWith(prefix);
  }
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Whether a parsed callback URL falls under an endpoint: exact origin, path under the prefix. */
export function callbackUrlMatchesEndpoint(
  url: Pick<ParsedCallbackUrl, 'origin' | 'path'>,
  endpoint: { origin: string; pathPrefix: string }
): boolean {
  return url.origin === endpoint.origin && pathUnderPrefix(url.path, endpoint.pathPrefix);
}

/** The URL an `endpointId` choice posts to: the endpoint's origin and path prefix. */
export function endpointUrl(endpoint: { origin: string; pathPrefix: string }): string {
  return `${endpoint.origin}${endpoint.pathPrefix}`;
}

// ── Sealed columns ──────────────────────────────────────────────────────────

/** The sealed URL columns of a `RunCallback` row. */
export interface SealedCallbackUrl {
  urlCiphertext: Uint8Array<ArrayBuffer>;
  urlNonce: Uint8Array<ArrayBuffer>;
  urlAuthTag: Uint8Array<ArrayBuffer>;
  urlKeyVersion: number;
}

export function sealCallbackUrl(url: string): SealedCallbackUrl {
  const sealed = encryptSecret(url);
  // `lastFour` is deliberately dropped: the tail of a URL may be part of a token.
  return {
    urlAuthTag: sealed.authTag,
    urlCiphertext: sealed.ciphertext,
    urlKeyVersion: sealed.keyVersion,
    urlNonce: sealed.nonce,
  };
}

export function openCallbackUrl(row: {
  urlCiphertext: Uint8Array;
  urlNonce: Uint8Array;
  urlAuthTag: Uint8Array;
  urlKeyVersion: number;
}): string {
  return decryptSecret({
    authTag: row.urlAuthTag,
    ciphertext: row.urlCiphertext,
    keyVersion: row.urlKeyVersion,
    nonce: row.urlNonce,
  });
}

/** The signing-secret columns of a `CallbackEndpoint` row. */
export interface EndpointSecretColumns {
  signingSecretCiphertext: Uint8Array;
  signingSecretNonce: Uint8Array;
  signingSecretAuthTag: Uint8Array;
  signingSecretKeyVersion: number;
  signingSecretLastFour: string;
  previousSigningSecretCiphertext: Uint8Array | null;
  previousSigningSecretNonce: Uint8Array | null;
  previousSigningSecretAuthTag: Uint8Array | null;
  previousSigningSecretKeyVersion: number | null;
  previousSigningSecretLastFour: string | null;
  previousSigningSecretExpiresAt: Date | null;
}

/** A fresh secret and the columns that hold it (no previous secret). */
export function newEndpointSecretColumns(): {
  secret: string;
  data: {
    signingSecretCiphertext: Uint8Array<ArrayBuffer>;
    signingSecretNonce: Uint8Array<ArrayBuffer>;
    signingSecretAuthTag: Uint8Array<ArrayBuffer>;
    signingSecretKeyVersion: number;
    signingSecretLastFour: string;
  };
} {
  const secret = generateWebhookSigningSecret();
  const sealed = encryptSecret(secret);
  return {
    data: {
      signingSecretAuthTag: sealed.authTag,
      signingSecretCiphertext: sealed.ciphertext,
      signingSecretKeyVersion: sealed.keyVersion,
      signingSecretLastFour: sealed.lastFour,
      signingSecretNonce: sealed.nonce,
    },
    secret,
  };
}

/**
 * Columns for a rotation: a new current secret, the replaced one kept as
 * previous until `now + 24 h`. A secret replaced while a previous one was
 * still live drops that older one — only two are ever held.
 */
export function rotatedEndpointSecretColumns(
  existing: EndpointSecretColumns,
  now: Date
): { secret: string; previousExpiresAt: Date; data: Record<string, unknown> } {
  const fresh = newEndpointSecretColumns();
  const previousExpiresAt = new Date(now.getTime() + CALLBACK_SECRET_ROTATION_OVERLAP_MS);
  return {
    data: {
      ...fresh.data,
      previousSigningSecretAuthTag: existing.signingSecretAuthTag,
      previousSigningSecretCiphertext: existing.signingSecretCiphertext,
      previousSigningSecretExpiresAt: previousExpiresAt,
      previousSigningSecretKeyVersion: existing.signingSecretKeyVersion,
      previousSigningSecretLastFour: existing.signingSecretLastFour,
      previousSigningSecretNonce: existing.signingSecretNonce,
    },
    previousExpiresAt,
    secret: fresh.secret,
  };
}

/** The secrets a delivery is signed with: current first, then a previous one still in its overlap. */
export function endpointSigningSecrets(endpoint: EndpointSecretColumns, now: Date): string[] {
  const secrets = [
    decryptSecret({
      authTag: endpoint.signingSecretAuthTag,
      ciphertext: endpoint.signingSecretCiphertext,
      keyVersion: endpoint.signingSecretKeyVersion,
      nonce: endpoint.signingSecretNonce,
    }),
  ];
  const expires = endpoint.previousSigningSecretExpiresAt;
  if (
    endpoint.previousSigningSecretCiphertext &&
    endpoint.previousSigningSecretNonce &&
    endpoint.previousSigningSecretAuthTag &&
    endpoint.previousSigningSecretKeyVersion != null &&
    expires &&
    expires > now
  ) {
    secrets.push(
      decryptSecret({
        authTag: endpoint.previousSigningSecretAuthTag,
        ciphertext: endpoint.previousSigningSecretCiphertext,
        keyVersion: endpoint.previousSigningSecretKeyVersion,
        nonce: endpoint.previousSigningSecretNonce,
      })
    );
  }
  return secrets;
}

// ── Payload ─────────────────────────────────────────────────────────────────

/** What a payload says about the run. Never transcripts, traces or context snapshots. */
export interface CallbackRunSummary {
  workRequestId: string | null;
  workflowRunId: string;
  temporalWorkflowId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
  pullRequestUrl?: string;
  dashboardUrl: string;
}

export interface CallbackPayload {
  /** The delivery id, also sent as `X-AutoSwe-Delivery`. */
  id: string;
  type: CallbackEventType;
  createdAt: string;
  run: CallbackRunSummary;
  /** Present on `run.waiting_for_human`. */
  humanStep?: { id: string; kind: string; dashboardUrl: string };
  /** The caller's `context`, as given; null when none was. */
  context: unknown;
}

export interface BuildCallbackPayloadInput {
  deliveryId: string;
  type: CallbackEventType;
  createdAt: Date;
  webUrl: string;
  run: {
    id: string;
    workflowId: string;
    workRequestId: string | null;
    status: string;
    startedAt: Date;
    endedAt: Date | null;
    costUsd: number;
    pullRequestUrl?: string | null;
  };
  humanStep?: { id: string; kind: string };
  context: unknown;
}

/** The one place a payload is assembled, so its fields are listed once. */
export function buildCallbackPayload(input: BuildCallbackPayloadInput): CallbackPayload {
  const web = input.webUrl.replace(/\/+$/, '');
  const run: CallbackRunSummary = {
    costUsd: Math.round(input.run.costUsd * 1e6) / 1e6,
    dashboardUrl: `${web}/runs/${input.run.id}`,
    endedAt: input.run.endedAt ? input.run.endedAt.toISOString() : null,
    startedAt: input.run.startedAt.toISOString(),
    status: input.run.status,
    temporalWorkflowId: input.run.workflowId,
    workflowRunId: input.run.id,
    workRequestId: input.run.workRequestId,
    ...(input.run.pullRequestUrl ? { pullRequestUrl: input.run.pullRequestUrl } : {}),
  };
  return {
    context: input.context ?? null,
    createdAt: input.createdAt.toISOString(),
    id: input.deliveryId,
    run,
    type: input.type,
    ...(input.humanStep
      ? {
          humanStep: {
            dashboardUrl: `${web}/inbox`,
            id: input.humanStep.id,
            kind: input.humanStep.kind,
          },
        }
      : {}),
  };
}

/** The outbox's per-event uniqueness key. */
export function callbackDedupeKey(
  runId: string,
  type: CallbackEventType,
  humanStepId?: string
): string {
  return humanStepId ? `${runId}:${type}:${humanStepId}` : `${runId}:${type}`;
}

// ── Delivery ────────────────────────────────────────────────────────────────

/** Fixed classes for a failed attempt. Never a transport error's text or a response body. */
export const CALLBACK_DELIVERY_ERRORS = [
  'TIMEOUT',
  'NETWORK',
  'ADDRESS_REFUSED',
  'REDIRECT',
  'HTTP_STATUS',
] as const;
export type CallbackDeliveryError = (typeof CALLBACK_DELIVERY_ERRORS)[number];

/** Why a delivery is DEAD. */
export const CALLBACK_DEAD_REASONS = [
  'RETRIES_EXHAUSTED',
  'ENDPOINT_DELETED',
  'ENDPOINT_DISABLED',
  'ENDPOINT_CHANGED',
  'CALLBACK_GONE',
  'URL_UNREADABLE',
  'SECRET_UNREADABLE',
] as const;
export type CallbackDeadReason = (typeof CALLBACK_DEAD_REASONS)[number];

/** A delivery is retried for this long from its first attempt (or its last redelivery). */
export const CALLBACK_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

/**
 * Delay before the next attempt after `attempts` failed ones: 1 min, doubling,
 * capped at 6 h — 1, 2, 4, … 256 min, then every 6 h until the window closes.
 */
export function callbackRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(FIRST_RETRY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

/**
 * When to try again after a failed attempt, or null when the next try would
 * fall outside the retry window and the delivery is DEAD.
 */
export function nextCallbackAttemptAt(
  attempts: number,
  windowStartedAt: Date,
  now: Date
): Date | null {
  const next = new Date(now.getTime() + callbackRetryDelayMs(attempts));
  return next.getTime() > windowStartedAt.getTime() + CALLBACK_RETRY_WINDOW_MS ? null : next;
}
