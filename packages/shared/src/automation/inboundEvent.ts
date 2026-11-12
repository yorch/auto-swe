import { z } from 'zod';
import { isJsonPointer, MAX_JSON_POINTER_LENGTH, resolveJsonPointer } from './jsonPointer.js';

/**
 * Event endpoints (docs/inbound-events.md): a team-owned URL another service posts signed events
 * to. This module is the pure half — how an endpoint is configured, the presets, and how one
 * verified event becomes the few values a decision is made on. Verification and storage are the
 * gateway's.
 */

/** How a sender proves a call is theirs. */
export const EVENT_ENDPOINT_SCHEMES = [
  'autoswe-v1',
  'hmac-sha256',
  'shared-secret-header',
] as const;
export type EventEndpointScheme = (typeof EVENT_ENDPOINT_SCHEMES)[number];

/** How the body is read: plain JSON, or a structured-mode CloudEvent. */
export const EVENT_ENDPOINT_FORMATS = ['json', 'cloudevents'] as const;
export type EventEndpointFormat = (typeof EVENT_ENDPOINT_FORMATS)[number];

/** How an `hmac-sha256` signature is written in its header. */
export const SIGNATURE_ENCODINGS = ['hex', 'base64'] as const;
export type SignatureEncoding = (typeof SIGNATURE_ENCODINGS)[number];

/** The most bytes an event body may have. */
export const MAX_EVENT_BODY_BYTES = 128 * 1024;
/** The longest text value an occurrence keeps (a mapped field, a matched value). */
export const MAX_EVENT_VALUE_CHARS = 4_000;
/** The most an occurrence's recorded facts may serialise to. */
export const MAX_EVENT_FACTS_CHARS = 16_000;
/** The longest event type accepted. */
export const MAX_EVENT_TYPE_CHARS = 256;
/** Ids, subjects and scopes longer than this, or with other characters, are kept as a hash. */
const MAX_KEY_CHARS = 200;
const SAFE_KEY_RE = /^[A-Za-z0-9._:@+=/-]+$/;

/** A header a sender's signature or secret travels in. */
export const SignatureHeaderSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,64}$/, 'a header name: letters, digits and "-"')
  .refine(
    (h) =>
      !['content-type', 'content-length', 'host', 'x-autoswe-delivery'].includes(h.toLowerCase()),
    'not a header that can carry a signature'
  )
  // CloudEvents attributes travel in ce-* headers, which the receiver refuses outright.
  .refine((h) => !h.toLowerCase().startsWith('ce-'), 'a ce-* header is a CloudEvents attribute');

export const JsonPointerSchema = z
  .string()
  .max(MAX_JSON_POINTER_LENGTH)
  .refine(isJsonPointer, 'a JSON Pointer: "" or "/a/b", with "~0" for "~" and "~1" for "/"');

/** Where the event's own fields are in its document. */
export interface EventEndpointPointers {
  /**
   * Where the type is in the body. Ignored when `fixedType` is set (stored as `""` then): a
   * fixed-type endpoint never resolves it, so `""` does not mean "the whole document" there.
   */
  typePointer: string;
  /**
   * A constant event type for senders that carry the type in an unsigned header, or have a
   * single kind of event. Only the signed body decides an event's type, so no header is read.
   */
  fixedType?: string | null;
  idPointer: string | null;
  subjectPointer: string | null;
  scopePointer: string | null;
  timePointer: string | null;
}

/** What an endpoint is configured with, secrets aside. */
export interface EventEndpointConfig extends EventEndpointPointers {
  scheme: EventEndpointScheme;
  /** For `hmac-sha256` and `shared-secret-header`: the header the value is in. */
  signatureHeader: string | null;
  /** Text before the value in that header, such as `sha256=` or `Bearer `. */
  signaturePrefix: string | null;
  /** For `hmac-sha256`. */
  signatureEncoding: SignatureEncoding | null;
  format: EventEndpointFormat;
}

/** The CloudEvents attribute each pointer reads in a CloudEvent's envelope. */
export const CLOUDEVENTS_POINTERS: EventEndpointPointers = {
  idPointer: '/id',
  scopePointer: '/source',
  subjectPointer: '/subject',
  timePointer: '/time',
  typePointer: '/type',
};

/**
 * Starting points for an endpoint's configuration: data, not behaviour. Each is only what the
 * form fills in; every field can be changed before it is saved.
 */
/** The characters a constant event type may use (also enforced by a CHECK constraint). */
export const FIXED_EVENT_TYPE_RE = /^[A-Za-z0-9._:@+=/-]{1,256}$/;

export const FixedEventTypeSchema = z
  .string()
  .max(MAX_EVENT_TYPE_CHARS)
  .regex(FIXED_EVENT_TYPE_RE, 'letters, digits and . _ : @ + = / - only');

/**
 * Exactly one of `typePointer` (non-empty) and `fixedType` configures the type. Returns the
 * stored pair: a fixed type is stored with `typePointer` `""`.
 */
export function resolveTypeSource(input: {
  typePointer?: string | null;
  fixedType?: string | null;
}): { ok: true; typePointer: string; fixedType: string | null } | { ok: false; message: string } {
  const fixed = input.fixedType ?? null;
  const pointer = input.typePointer ?? '';
  if (fixed !== null) {
    if (pointer !== '') {
      return { message: 'Set either typePointer or fixedType, not both', ok: false };
    }
    return { fixedType: fixed, ok: true, typePointer: '' };
  }
  // `""` addresses the whole document, which for a JSON object body is never a type and for a
  // scalar body makes the sender's whole body the type. A row stored that way before this check
  // is still read as it is; only a write is refused.
  if (pointer === '') {
    return {
      message:
        'typePointer must name the field that holds the event type; to give every event one type, set fixedType instead',
      ok: false,
    };
  }
  return { fixedType: null, ok: true, typePointer: pointer };
}

export const EVENT_ENDPOINT_PRESETS: ReadonlyArray<{
  key: string;
  label: string;
  description: string;
  config: EventEndpointConfig;
}> = [
  {
    config: {
      format: 'json',
      idPointer: '/id',
      scheme: 'autoswe-v1',
      scopePointer: null,
      signatureEncoding: null,
      signatureHeader: null,
      signaturePrefix: null,
      subjectPointer: '/subject',
      timePointer: null,
      typePointer: '/type',
    },
    description:
      'A JSON body with top-level type, id and subject, signed with X-AutoSwe-Signature (the same scheme as template webhooks).',
    key: 'autoswe-json',
    label: 'auto-swe signed JSON',
  },
  {
    config: {
      ...CLOUDEVENTS_POINTERS,
      format: 'cloudevents',
      scheme: 'autoswe-v1',
      signatureEncoding: null,
      signatureHeader: null,
      signaturePrefix: null,
    },
    description:
      'CloudEvents 1.0 in structured HTTP mode (application/cloudevents+json): type, id, subject and source (as the scope) come from the event’s attributes.',
    key: 'cloudevents',
    label: 'CloudEvents',
  },
  {
    config: {
      format: 'json',
      idPointer: '/id',
      scheme: 'hmac-sha256',
      scopePointer: null,
      signatureEncoding: 'hex',
      signatureHeader: 'X-Hub-Signature-256',
      signaturePrefix: 'sha256=',
      subjectPointer: null,
      timePointer: null,
      typePointer: '/action',
    },
    description:
      'An HMAC-SHA256 of the raw body in X-Hub-Signature-256 as sha256=<hex>, the way GitHub signs webhooks. The pointers are placeholders: set them to where the sender puts its event type and id.',
    key: 'hmac-github-style',
    label: 'HMAC-SHA256, GitHub-style header',
  },
  {
    config: {
      fixedType: 'project_snapshot/v0',
      format: 'json',
      idPointer: null,
      scheme: 'hmac-sha256',
      scopePointer: '/project/id',
      signatureEncoding: 'hex',
      signatureHeader: 'X-Hub-Signature',
      signaturePrefix: 'sha256=',
      subjectPointer: '/project/id',
      timePointer: null,
      typePointer: '',
    },
    description:
      'Snyk project snapshots: an HMAC-SHA256 hex digest of the request body in X-Hub-Signature as sha256=<hex>, a constant event type (Snyk names it only in the unsigned X-Snyk-Event header), and the Snyk project id (/project/id) as subject and scope so the cooldown and in-flight checks count per project. The body has no event id, so each delivery is keyed by a digest of its body. Snyk documents the digest as of "the request body" without saying whether it is the raw bytes; check the first delivery. Every automation on this endpoint needs two match rules, /newIssues/0 exists and /newIssues/0/issueType eq vuln: without them every snapshot and ping starts a run, bounded only by the cooldown and the daily cap.',
    key: 'snyk',
    label: 'Snyk project snapshot',
  },
  {
    config: {
      format: 'json',
      idPointer: '/event/id',
      scheme: 'hmac-sha256',
      scopePointer: '/event/data/service/id',
      signatureEncoding: 'hex',
      signatureHeader: 'X-PagerDuty-Signature',
      signaturePrefix: 'v1=',
      subjectPointer: '/event/data/id',
      timePointer: '/event/occurred_at',
      typePointer: '/event/event_type',
    },
    description:
      'PagerDuty v3 webhook subscriptions: an HMAC-SHA256 hex digest of the raw body in X-PagerDuty-Signature as v1=<hex>, one per signing secret while PagerDuty rotates it. The type is /event/event_type (incident.triggered, incident.resolved, …), the id /event/id, the subject the incident (/event/data/id) and the scope its service (/event/data/service/id), so the cooldown counts per service. PagerDuty generates the secret: paste it when creating the endpoint. Every automation on this endpoint should select incident.triggered only and match /event/data/service/id to the service its repository serves.',
    key: 'pagerduty-v3',
    label: 'PagerDuty v3 webhook',
  },
];

/** One verified event, as every automation of its endpoint reads it. Never stored whole. */
export interface InboundEvent {
  endpointId: string;
  type: string;
  /** The event's id as a key: the sender's, or `sha256:<hex>` of the raw body when it has none. */
  id: string;
  subject: string;
  scope: string;
  time?: string;
  /** The parsed document the pointers address: the JSON body, or the CloudEvent's envelope. */
  document: unknown;
}

export type InboundEventExtraction =
  | { ok: true; event: InboundEvent }
  | { ok: false; code: 'EVENT_TYPE_MISSING' | 'EVENT_TYPE_TOO_LONG'; message: string };

/** A scalar as text, or null for anything else (an object, an array, null, a missing value). */
function scalarText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/**
 * Text fit to be a ledger key: short text of safe characters as it is, anything else as
 * `sha256:<hex>`, so two different values never collide and no key carries arbitrary text.
 */
export function eventKeyText(text: string, hash: (text: string) => string): string {
  return text.length <= MAX_KEY_CHARS && SAFE_KEY_RE.test(text) ? text : `sha256:${hash(text)}`;
}

/**
 * The event's own fields, read with the endpoint's pointers. The type is required and must be
 * text, or the endpoint's constant `fixedType`; the id falls back to a digest of the raw body (`bodyDigest`, hex SHA-256), the subject to
 * the id, and the scope to the type (so with a fixed type the default scope is that constant;
 * set `scopePointer` for a per-source scope).
 */
export function extractInboundEvent(input: {
  endpointId: string;
  pointers: EventEndpointPointers;
  document: unknown;
  /** Hex SHA-256 of the raw body, the id of an event that names none. */
  bodyDigest: string;
  hash: (text: string) => string;
}): InboundEventExtraction {
  const { pointers, document, hash } = input;
  const read = (pointer: string | null) => {
    if (pointer === null) {
      return null;
    }
    const found = resolveJsonPointer(document, pointer);
    if (!found.found) {
      return null;
    }
    const text = scalarText(found.value);
    return text === null || text.length === 0 ? null : text;
  };
  // A fixed type wins and the pointer is never resolved: `""` would address the whole document.
  const type = pointers.fixedType ? pointers.fixedType : read(pointers.typePointer);
  if (type === null) {
    return {
      code: 'EVENT_TYPE_MISSING',
      message: 'The event has no type where the endpoint looks for it',
      ok: false,
    };
  }
  if (type.length > MAX_EVENT_TYPE_CHARS) {
    return { code: 'EVENT_TYPE_TOO_LONG', message: 'The event type is too long', ok: false };
  }
  const rawId = read(pointers.idPointer);
  const id = rawId === null ? `sha256:${input.bodyDigest}` : eventKeyText(rawId, hash);
  const rawSubject = read(pointers.subjectPointer);
  const rawScope = read(pointers.scopePointer);
  const time = read(pointers.timePointer);
  return {
    event: {
      document,
      endpointId: input.endpointId,
      id,
      scope: rawScope === null ? eventKeyText(type, hash) : eventKeyText(rawScope, hash),
      subject: rawSubject === null ? id : eventKeyText(rawSubject, hash),
      type,
      ...(time !== null && time.length <= 64 ? { time } : {}),
    },
    ok: true,
  };
}

/** Whether a structured-mode body is a CloudEvent this receiver reads. */
export function isCloudEventEnvelope(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.specversion === 'string' &&
    /^1(\.\d+)?$/.test(v.specversion) &&
    ['id', 'source', 'type'].every((k) => typeof v[k] === 'string' && (v[k] as string).length > 0)
  );
}
