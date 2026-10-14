import { createHash } from 'node:crypto';
import { stableStringify } from './stableJson.js';

/**
 * The parts of an in-app assistant's request to the gateway that both sides must agree on: the gateway
 * mints and checks the assistant's token, and the worker that runs the assistant presents it.
 *
 * See `docs/adr/in-app-assistant.md`.
 */

/**
 * Every assistant token starts with this, so `requireAuth` can tell it from a personal access token
 * (`ats_`) or an API JWT before verifying anything.
 */
export const ASSISTANT_TOKEN_PREFIX = 'asst_';

/** The header naming the confirmed `AssistantAction` a write is made under. */
export const ASSISTANT_ACTION_HEADER = 'x-assistant-action';

/** How long an assistant token lives. A turn mints a fresh one. */
export const ASSISTANT_TOKEN_TTL_SECONDS = 15 * 60;

/** How long a proposed action waits for the user's answer. */
export const ASSISTANT_ACTION_PENDING_TTL_MS = 60 * 60 * 1000;

/** How long a confirmed action may wait for the assistant to make the call. */
export const ASSISTANT_ACTION_CONFIRMED_TTL_MS = 5 * 60 * 1000;

export interface AssistantRequest {
  method: string;
  /** Path and query exactly as sent: `/api/v1/...?a=b`. */
  url: string;
  /** The JSON body, or undefined when the request has none. */
  body: unknown;
}

/**
 * The digest a confirmation is bound to. Covers the method, the URL with its query, and the body in
 * canonical form, so the call the assistant makes is the call the user saw, field for field. A request
 * with no body and one with a `null` body digest the same; nothing else collides.
 */
export function assistantActionDigest(request: AssistantRequest): string {
  const canonical = stableStringify({
    body: request.body === undefined ? null : request.body,
    method: request.method.toUpperCase(),
    url: request.url,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
