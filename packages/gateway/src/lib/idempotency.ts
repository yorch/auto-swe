import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Caller-supplied idempotency for the generic run triggers.
 *
 * `POST /workflow-templates/:id/runs` and `POST /webhooks/:token` accept any
 * payload, so there is nothing intrinsic to derive a stable workflow ID from —
 * unlike a work request, which has a ticket ID. Without one, the unique index on
 * `ActiveWorkflow.temporalWorkflowId` never fires and a retried or double-fired
 * trigger silently starts a second run.
 *
 * Hashing rather than embedding the key keeps arbitrary client input out of the
 * Temporal workflow ID (and out of the dashboard), and bounds the ID's length
 * and charset regardless of what was sent.
 *
 * Deliberately **opt-in**: a caller that sends no key keeps the previous
 * behaviour of one fresh run per request. Deriving an ID from the payload
 * instead would make dedup automatic, but would also refuse the legitimate
 * "run this same thing again" that a schedule or a manual retry wants.
 */

/**
 * Long enough for a UUID or a caller's own composite key, short enough that the
 * header cannot be used as an unbounded write channel.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** `Idempotency-Key`, when present. Fastify lower-cases incoming header names. */
export const IdempotencyHeaderSchema = z
  .object({
    'idempotency-key': z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH).optional(),
  })
  .loose();

/**
 * Deterministic Temporal workflow ID for `key`, scoped to `scopeId` so the same
 * key against two different templates cannot collide.
 *
 * The digest is truncated to 16 hex chars (64 bits). Collisions are a
 * within-template concern only, and a collision manifests as a 409 rather than
 * as two runs merging — the conservative direction.
 *
 * The scope is length-prefixed rather than joined by a separator character: any
 * separator that can also occur inside `scopeId` lets two different (scope, key)
 * pairs hash to the same string. (A literal NUL works too, but a NUL byte in
 * source is invisible in review.)
 */
export function workflowIdFromIdempotencyKey(prefix: string, scopeId: string, key: string): string {
  const digest = createHash('sha256').update(`${scopeId.length}:${scopeId}${key}`).digest('hex');
  return `${prefix}-${scopeId}-${digest.slice(0, 16)}`;
}

/**
 * A deterministic UUID for `key`, scoped like {@link workflowIdFromIdempotencyKey}, for a launch
 * whose workflow ID embeds a row's UUID primary key (a campaign is `campaign-<campaignId>`). The
 * first 128 bits of the same length-prefixed SHA-256, written as an RFC 9562 version-8 UUID
 * (application-defined), so the row id, the route's UUID parameters and the workflow ID all keep
 * their shapes. Two different (scope, key) pairs collide only with SHA-256's own probability,
 * and a collision is a refused launch, never two merged ones.
 */
export function uuidFromIdempotencyKey(scopeId: string, key: string): string {
  const hex = createHash('sha256').update(`${scopeId.length}:${scopeId}${key}`).digest('hex');
  const variant = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
