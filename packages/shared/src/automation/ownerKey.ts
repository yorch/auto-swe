/**
 * Who a decision in the automation ledger belongs to (`AutomationFire.ownerKey`,
 * docs/automations.md §2). The guards count one source's decisions on one owner.
 *
 * - A **repository** is `<host>/<owner>/<repo>`, lowercased: the repository by its name on its
 *   host, whichever connection row matched. These keys are written into every event source's
 *   dedupe key, so their spelling never changes: a redelivered webhook must find the decision
 *   recorded for it.
 * - Anything else is `@<kind>/<id>` (`@team/<uuid>`, `@owner/<schedule or template id>`). A
 *   host never contains `@`, so the two shapes cannot collide.
 */

/** The first character of every owner key that is not a repository. */
export const OWNER_KEY_SIGIL = '@';

/** The kind of a non-repository owner the schedule and template-webhook rows use. */
export const LEDGER_OWNER_KIND = 'owner';

const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** `<host>/<owner>/<repo>`, lowercased: the repository, whichever connection row matched. */
export function repositoryOwnerKey(host: string, fullName: string): string {
  return `${host}/${fullName}`.toLowerCase();
}

/** `@<kind>/<id>`: an owner that is not a repository (a team, an endpoint, a schedule). */
export function sigilOwnerKey(kind: string, id: string): string {
  if (!KIND_RE.test(kind) || kind === 'repository') {
    throw new Error(`not an owner kind: ${kind}`);
  }
  if (id.length === 0) {
    throw new Error('an owner key needs an id');
  }
  return `${OWNER_KEY_SIGIL}${kind}/${id}`;
}

/** The owner key of a team's automations' decisions. */
export function teamOwnerKey(teamId: string): string {
  return sigilOwnerKey('team', teamId);
}

export type ParsedOwnerKey =
  | { kind: 'repository'; host: string; fullName: string }
  | { kind: string; id: string };

/**
 * An owner key read back: a repository's host and `owner/repo`, or a sigil owner's kind and id.
 * Null for a key that is neither (an empty key written before owners had a sigil).
 */
export function parseOwnerKey(key: string): ParsedOwnerKey | null {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) {
    return null;
  }
  if (key.startsWith(OWNER_KEY_SIGIL)) {
    const kind = key.slice(1, slash);
    return KIND_RE.test(kind) && kind !== 'repository' ? { id: key.slice(slash + 1), kind } : null;
  }
  return { fullName: key.slice(slash + 1), host: key.slice(0, slash), kind: 'repository' };
}

/** Whether the key names a repository (`<host>/<owner>/<repo>`), not a sigil owner. */
export function isRepositoryOwnerKey(key: string): boolean {
  return parseOwnerKey(key)?.kind === 'repository';
}

/** The host of a repository owner key, or null for any other key. */
export function ownerKeyHost(key: string): string | null {
  const parsed = parseOwnerKey(key);
  return parsed && 'host' in parsed ? parsed.host : null;
}
