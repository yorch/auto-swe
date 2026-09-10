/**
 * The one place a cached permission answer is written.
 *
 * Two callers refresh the projection — the scheduled sweep in the worker and
 * the webhook handler in the gateway — and they must agree about the rule that
 * matters: **a failed lookup writes nothing.** Leaving that to each caller
 * would mean one of them eventually recording an outage as a denial, and a
 * denial that GitHub never issued is indistinguishable from one it did.
 */
import type { PrismaClient } from '../index.js';
import type { PermissionLookup, RepoPermission } from './githubPermission.js';

/** Prisma's enum spelling for a host permission level. */
const TO_ENUM = {
  admin: 'ADMIN',
  none: 'NONE',
  read: 'READ',
  write: 'WRITE',
} as const satisfies Record<RepoPermission, 'ADMIN' | 'NONE' | 'READ' | 'WRITE'>;

/** What `recordRepoPermission` did, for the caller's counters and logs. */
export type ProjectionWrite =
  | { written: true; permission: RepoPermission }
  | { written: false; reason: string };

/**
 * Record what the host said about one (user, repository) pair.
 *
 * A `none` verdict IS written — it is a fact GitHub stated, and the gate has to
 * tell "has no access" apart from "has not been asked about". A *failure* is
 * not written at all: the existing row keeps its previous answer and its
 * previous `checkedAt`, so it ages out through the staleness window instead of
 * being overwritten.
 */
export async function recordRepoPermission(
  prisma: PrismaClient,
  args: { userId: string; connectionId: string; lookup: PermissionLookup }
): Promise<ProjectionWrite> {
  const { userId, connectionId, lookup } = args;
  if (!lookup.ok) {
    return { reason: lookup.failure, written: false };
  }
  const permission = TO_ENUM[lookup.permission];
  // `upsert` is safe here: `repo_access` has a plain unique index on
  // (user_id, connection_id), not one of the partial per-scope indexes that
  // force findFirst-then-create for Agent and ProviderCredential.
  await prisma.repoAccess.upsert({
    create: { connectionId, permission, userId },
    update: { checkedAt: new Date(), permission },
    where: { userId_connectionId: { connectionId, userId } },
  });
  return { permission: lookup.permission, written: true };
}
