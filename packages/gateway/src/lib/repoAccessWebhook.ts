/**
 * Turning a GitHub webhook into "whose permission answers are now wrong".
 *
 * The scheduled sweep bounds how long a stale answer can survive; this is what
 * makes revocation fast. Without it, someone removed from a repository keeps
 * whatever the projection last recorded until the next sweep, and the sweep
 * interval is then the real revocation window — which is the number an
 * operator would have to defend.
 *
 * Parsing is deliberately separate from acting so the payload shapes can be
 * tested without a database. Everything here treats the payload as untrusted
 * data; the caller has already verified the HMAC signature.
 */

/** Which cached answers a webhook invalidates. */
export type AccessInvalidation =
  /** One user on one repository — a direct collaborator change. */
  | { kind: 'pair'; org: string; repo: string; login: string }
  /** Every user on one repository — a team was added/removed, or the repo changed. */
  | { kind: 'repo'; org: string; repo: string }
  /** One user everywhere — they left the organization, or a team's membership changed. */
  | { kind: 'user'; login: string }
  /** Nothing this event can affect. */
  | { kind: 'ignored'; reason: string };

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function repoIdentity(payload: Record<string, unknown>): { org: string; repo: string } | null {
  const repository = payload.repository as Record<string, unknown> | undefined;
  if (!repository) {
    return null;
  }
  const owner = repository.owner as Record<string, unknown> | undefined;
  const org = str(owner?.login);
  const repo = str(repository.name);
  return org && repo ? { org, repo } : null;
}

/**
 * Classify a GitHub webhook by what it invalidates.
 *
 * `eventType` is the `X-GitHub-Event` header. Only the events that can change
 * who may reach a repository are handled; everything else is ignored by name
 * rather than by omission, so an unexpected event is visibly a no-op instead of
 * a silent one.
 */
export function classifyAccessEvent(eventType: string, body: unknown): AccessInvalidation {
  if (typeof body !== 'object' || body === null) {
    return { kind: 'ignored', reason: 'payload is not an object' };
  }
  const payload = body as Record<string, unknown>;
  const action = str(payload.action);

  switch (eventType) {
    case 'member': {
      // A collaborator added to, removed from, or re-graded on one repository.
      const identity = repoIdentity(payload);
      const login = str((payload.member as Record<string, unknown> | undefined)?.login);
      if (!(identity && login)) {
        return { kind: 'ignored', reason: 'member event without a repository and member' };
      }
      return { ...identity, kind: 'pair', login };
    }

    case 'team': {
      // A whole team gained or lost the repository, so every member's answer
      // for it may have changed and none of them are named in the payload.
      if (action !== 'added_to_repository' && action !== 'removed_from_repository') {
        return { kind: 'ignored', reason: `team action '${action}' does not change repo access` };
      }
      const identity = repoIdentity(payload);
      return identity
        ? { ...identity, kind: 'repo' }
        : { kind: 'ignored', reason: 'team event without a repository' };
    }

    case 'membership': {
      // Someone joined or left a GitHub team. Which repositories that team can
      // reach is not in the payload, so the whole user is invalidated.
      const login = str((payload.member as Record<string, unknown> | undefined)?.login);
      return login
        ? { kind: 'user', login }
        : { kind: 'ignored', reason: 'membership event without a member' };
    }

    case 'organization': {
      if (action !== 'member_removed') {
        return {
          kind: 'ignored',
          reason: `organization action '${action}' does not remove access`,
        };
      }
      const membership = payload.membership as Record<string, unknown> | undefined;
      const login = str((membership?.user as Record<string, unknown> | undefined)?.login);
      return login
        ? { kind: 'user', login }
        : { kind: 'ignored', reason: 'organization event without a removed user' };
    }

    case 'repository': {
      // Visibility, transfer, archival and deletion all change who GitHub says
      // can reach the repository, and none of them name a user.
      const relevant = new Set([
        'archived',
        'deleted',
        'privatized',
        'publicized',
        'transferred',
        'unarchived',
      ]);
      if (!action || !relevant.has(action)) {
        return {
          kind: 'ignored',
          reason: `repository action '${action}' does not change access`,
        };
      }
      const identity = repoIdentity(payload);
      return identity
        ? { ...identity, kind: 'repo' }
        : { kind: 'ignored', reason: 'repository event without a repository' };
    }

    default:
      return { kind: 'ignored', reason: `event '${eventType}' does not affect access` };
  }
}
