import type { Prisma } from '@auto-swe/shared';

/**
 * THE LOCK ORDER. Every transaction that takes more than one row lock takes them in this order, and
 * only ever forward. Two transactions that each hold a lock the other wants can only exist if some
 * code went backwards; Postgres then aborts one of them with `40P01` and the caller sees a 500.
 *
 *   0. advisory locks keyed by a person (`join-request:<id>`, `team-create:<id>`, `mcp-launch:<id>`)
 *   1. user rows, ascending id            `lockUser`            FOR NO KEY UPDATE
 *   2. connection rows, ascending id      `lockConnections`     FOR UPDATE
 *   3. organization rows, ascending id    `lockOrganizations`   FOR UPDATE, or FOR SHARE
 *   4. team rows, ascending id            `lockTeams`           FOR UPDATE, or FOR SHARE
 *   5. then the rows a write touches (requests, memberships, the audit log), which nothing else
 *      holds while waiting for a lock above
 *
 * A caller takes the levels it needs, skips the ones it does not, and never takes a lower level
 * after a higher one. A set of rows of one level goes through one call, so the ascending order
 * holds across them: two transactions that lock the same two teams cannot cross.
 *
 * Why the user level is `FOR NO KEY UPDATE` and not `FOR UPDATE`: a workflow launch holds the
 * launcher's user row for its whole transaction, so that a role or active-flag change waits for it,
 * and then waits for the connection, organization and team rows. A membership insert (a join
 * approval, a member added, a request created) holds the team row and must then take a share lock
 * on the user row it references, the foreign key check. `FOR UPDATE` conflicts with that share
 * lock, so the launch waits for the team while the insert waits for the user: a cycle, with the
 * insert in a transaction that cannot know whose row it will meet. `FOR NO KEY UPDATE` still
 * conflicts with every other writer of the row (an update, a delete, another launch) and does not
 * conflict with a foreign key check, so the insert never waits on a launch and the cycle cannot
 * form. A writer that only inserts rows referencing a user therefore takes no user lock at all.
 * `lockOrder.pg.test.ts` stages each interleaving against a real database.
 *
 * Organization and team locks come in two strengths. `FOR UPDATE` is what a membership write, an
 * approval, a deactivation and a launch take. `FOR SHARE` is for a writer that only needs the row
 * to stay as it is (a request's creation, a rejection), so those do not serialize with each other.
 *
 * Each helper returns what it found: whether the user exists, or the ids that exist. A caller whose
 * row is gone decides what that means; none of these throws for it.
 */

/** `FOR UPDATE` excludes every other lock of the level; `FOR SHARE` excludes only `FOR UPDATE`. */
export type RowLockMode = 'share' | 'update';

const ascending = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

/**
 * Level 1. Locks one user's row `FOR NO KEY UPDATE`, held to the end of the transaction.
 * Returns whether the row exists.
 */
export async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  // CLAUDE.md §7 exception: serializes a role or active-flag check with writers of the user row;
  // Prisma cannot express SELECT … FOR NO KEY UPDATE. See the lock order above.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE
  `;
  return rows.length > 0;
}

/** Level 2. Locks connection rows `FOR UPDATE`, in ascending id order; returns the ids found. */
export async function lockConnections(
  tx: Prisma.TransactionClient,
  connectionIds: readonly string[]
): Promise<string[]> {
  const found: string[] = [];
  for (const id of ascending(connectionIds)) {
    // CLAUDE.md §7 exception: repository moves and launches lock the row; Prisma cannot express
    // SELECT … FOR UPDATE. See the lock order above.
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM connections WHERE id = ${id}::uuid FOR UPDATE
    `;
    if (rows.length > 0) {
      found.push(id);
    }
  }
  return found;
}

/** Level 3. Locks organization rows in ascending id order; returns the ids found. */
export async function lockOrganizations(
  tx: Prisma.TransactionClient,
  orgIds: readonly string[],
  mode: RowLockMode = 'update'
): Promise<string[]> {
  const found: string[] = [];
  for (const id of ascending(orgIds)) {
    // CLAUDE.md §7 exception: the organization row lock that membership writes, join decisions,
    // deactivation and launches serialize on; Prisma cannot express SELECT … FOR UPDATE / FOR
    // SHARE. See the lock order above.
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM organizations WHERE id = ${id}::uuid FOR UPDATE
          `
        : await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM organizations WHERE id = ${id}::uuid FOR SHARE
          `;
    if (rows.length > 0) {
      found.push(id);
    }
  }
  return found;
}

/** Level 4. Locks team rows in ascending id order; returns the ids found. */
export async function lockTeams(
  tx: Prisma.TransactionClient,
  teamIds: readonly string[],
  mode: RowLockMode = 'update'
): Promise<string[]> {
  const found: string[] = [];
  for (const id of ascending(teamIds)) {
    // CLAUDE.md §7 exception: the team row lock every membership write and launch source check
    // takes; Prisma cannot express SELECT … FOR UPDATE / FOR SHARE. See the lock order above.
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM teams WHERE id = ${id}::uuid FOR UPDATE
          `
        : await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM teams WHERE id = ${id}::uuid FOR SHARE
          `;
    if (rows.length > 0) {
      found.push(id);
    }
  }
  return found;
}

/**
 * Levels 3 and 4 for one team: its organization, then the team. What a membership write takes, so
 * an organization removal (which deletes team memberships under both locks) cannot interleave.
 */
export async function lockOrgThenTeam(
  tx: Prisma.TransactionClient,
  orgId: string,
  teamId: string,
  mode: RowLockMode = 'update'
): Promise<void> {
  await lockOrganizations(tx, [orgId], mode);
  await lockTeams(tx, [teamId], mode);
}
