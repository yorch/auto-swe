/**
 * The orchestration token: what the worker presents when it calls an orchestration's child,
 * message and cancel routes. A JWT of its own audience behind a prefix, so it is never mistaken
 * for an API access token, a PAT or an assistant token.
 *
 * Claims: `oid` (the orchestration) and exactly one of `uid` (the launching person, whom every
 * child acts as) or `sid` (the service principal that launched it). Expiry is the orchestration's
 * lifetime plus a grace period. `requireAuth` admits it only on a route that declares
 * `config.orchestrationToken`, only for the orchestration named by the route's `:id`, and only
 * while the orchestration is ACTIVE or WAITING; ending or cancelling it revokes every token.
 */
export const ORCHESTRATION_TOKEN_PREFIX = 'orch_';
export const ORCHESTRATION_TOKEN_AUDIENCE = 'auto-swe:orchestration';
/** Added to the pinned wall clock so a turn that straddles the deadline can still report. */
export const ORCHESTRATION_TOKEN_GRACE_SECONDS = 15 * 60;

export interface OrchestrationTokenClaims {
  orchestrationId: string;
  /** The launching person; null when a service principal launched it. */
  userId: string | null;
  /** The launching service principal; null when a person launched it. */
  serviceId: string | null;
}

export function orchestrationTokenTtlSeconds(maxWallClockSeconds: number): number {
  return maxWallClockSeconds + ORCHESTRATION_TOKEN_GRACE_SECONDS;
}
