import type { Prisma } from '@auto-swe/shared';

/**
 * THE LOCK ORDER. Every transaction that takes more than one row lock takes them in this order, and
 * only ever forward. Two transactions that each hold a lock the other wants can only exist if some
 * code went backwards; Postgres then aborts one of them with `40P01` and the caller sees a 500.
 *
 *   0. advisory locks keyed by a person (`join-request:<id>`, `team-create:<id>`, `mcp-launch:<id>`)
 *   1. user rows, ascending id            `lockUser`              FOR NO KEY UPDATE
 *   2. service principal rows             `lockServicePrincipal`  FOR UPDATE
 *   3. connection rows, ascending id      `lockConnections`       FOR UPDATE
 *   4. organization rows, ascending id    `lockOrganizations`     FOR UPDATE, or FOR SHARE
 *   5. team rows, ascending id            `lockTeams`             FOR UPDATE, or FOR SHARE
 *   6. then the rows a write touches, which nothing above waits on while holding a lock of its own:
 *      join-request rows (a bulk close takes every row it will close, ascending id, through
 *      `lockOpenJoinRequests`; an approval or a withdrawal claims the one row it decides),
 *      an orchestration's row and its messages' rows (the order between those two is per path, see the
 *      table: attach resolution and message resolution take the message first, spawn, reopen and
 *      wake take the orchestration first, and no path holds one while waiting for the other).
 *      Memberships, the audit log and the other rows a write inserts carry no lock of their own.
 *
 * A caller takes the levels it needs, skips the ones it does not, and never takes a lower level
 * after a higher one. A set of rows of one level goes through one call, so the ascending order
 * holds across them: two transactions that lock the same two teams cannot cross. A transaction
 * that has to take a lock of a lower level after a higher one is a bug, whatever it is guarding:
 * it takes the lower one first, even when the status it then reads says it will not need it.
 *
 * The sites in `packages/gateway/src` that take a row lock or an advisory lock themselves, and where
 * each sits. Locks taken inside shared packages the gateway calls (the agent lineage lock, harness-profile
 * name allocation, usage-rollup advisory locks, the knowledge service's run-then-connection pair) are
 * not listed and are not shown to be consistent with this order:
 *
 *   site                                           locks, in the order taken
 *   ---------------------------------------------  ------------------------------------------------
 *   workflowLaunch `lockLaunchSources`, source     user (actor), connections, organizations, teams
 *     checks, `launchTrackedWorkflow`
 *   workflowLaunch launch guards                   run before the sources: `runCapGuard` takes the
 *                                                  advisory 0; `servicePrincipalLaunchGuard` takes
 *                                                  the acting user when it carries one, the
 *                                                  principal (2), then its connection (3)
 *   teamJoinRequests create / approve / reject /   advisory 0, organization (4), team (5), the one
 *     withdraw (`lockOrgThenTeam`)                 request row (6)
 *   teamJoinRequests `closeOpenJoinRequests`,      the caller's own locks first (user 1 for a
 *     bulk, from users / teams / organization      deactivated account, team 5 for a team,
 *     deactivation                                 organization 4 for an organization), then every
 *                                                  matching request row (6), ascending id
 *   routes/users deactivation                      advisory 0, user (1), request rows (6)
 *   routes/teams creation, member writes,          advisory 0 (creation), organization (4),
 *     deletion; routes/orgMembers; inviteUser;     team (5), request rows (6)
 *     systemConfigService (default team)
 *   routes/repositories move and share edits       connection (3), then the rows they write
 *   mcpDeviceApproval                              user (1), then its device code and consent rows
 *   routes/servicePrincipals edit, mint, delete    principal (2) alone
 *   routes/orchestrations `prepareWake`            advisory 0 (a cap), principal (2), connection
 *                                                  (3), then the orchestration (6)
 *   routes/orchestrations spawn, reopen, attach    the launch's locks, then the orchestration (6);
 *     undo                                         an attach resolution takes its message (6) first
 *   routes/orchestrations message resolution       the message row (6), then the orchestration row
 *   hitlResolve multi-approver step                the step row alone
 *   routes/slackChannels delete                    the channel row alone
 *   skillSourceService                             advisory `skill-source:<id>`, then
 *                                                  `skill-name-allocation`
 *   lessonQuarantine, runPlanQuotas,               one advisory lock each, never with another lock
 *     pullRequestReview
 *   joinRequestNotificationPoller                  `FOR UPDATE SKIP LOCKED` on notification rows in
 *                                                  one statement: it never waits
 *
 * `yarn invariants:check` does not state this table: whether a lock site is "routed" is not
 * decidable by reading text, because a `FOR UPDATE` in a helper and one inline look alike and the
 * order between two calls is a property of control flow. `lockOrder.pg.test.ts` and
 * `lockSites.pg.test.ts` stage each cross-level interleaving against a real database.
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

/**
 * Level 2. Locks a service principal's row `FOR UPDATE`, held to the end of the transaction: what
 * serializes a principal's launches with each other and with edits to its allowlists and limits.
 * Returns whether the row exists. A launch by a principal carries no acting user; one that did
 * would take that user's row (level 1) before this one.
 */
export async function lockServicePrincipal(
  tx: Prisma.TransactionClient,
  servicePrincipalId: string
): Promise<boolean> {
  // CLAUDE.md §7 exception: serializes a principal's launches, edits, token mints and deletion;
  // Prisma cannot express SELECT … FOR UPDATE. See the lock order above.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM service_principals WHERE id = ${servicePrincipalId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}

/** Level 3. Locks connection rows `FOR UPDATE`, in ascending id order; returns the ids found. */
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

/** Level 4. Locks organization rows in ascending id order; returns the ids found. */
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

/** Level 5. Locks team rows in ascending id order; returns the ids found. */
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
 * Levels 4 and 5 for one team: its organization, then the team. What a membership write takes, so
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

/** Which join requests a bulk close takes: a requester's, a team's or an organization's teams'. */
export type JoinRequestLockScope = { userId: string } | { teamId: string } | { orgId: string };

/**
 * Level 6. Locks, `FOR UPDATE` and in ascending id order, every join request in one of `statuses`
 * that matches `scope`, and returns their ids. A bulk close (a user's, a team's or an
 * organization's deactivation) calls this before it changes any request, then updates by the ids
 * returned. One `UPDATE … WHERE <scope>` locks the rows in whatever order the plan reads them, so
 * two closes whose row sets overlap (an organization's and a team's, or a user's and an
 * organization's) can each hold a row the other waits for; `ORDER BY id` under `FOR UPDATE` locks
 * them in one order for everyone, and the later close waits at the first shared row holding
 * nothing the earlier one wants. A request that stops matching while this waits (a decision
 * claimed it) is not returned. The caller holds its own level 1 to 5 locks already.
 */
export async function lockOpenJoinRequests(
  tx: Prisma.TransactionClient,
  scope: JoinRequestLockScope,
  statuses: readonly string[]
): Promise<string[]> {
  const list = [...statuses];
  // CLAUDE.md §7 exception: every bulk close of join requests locks the rows it will close in one
  // order (ORDER BY id … FOR UPDATE); Prisma cannot express SELECT … FOR UPDATE. See the lock
  // order above.
  const rows =
    'userId' in scope
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r.id FROM team_join_requests r
          WHERE r.user_id = ${scope.userId}::uuid AND r.status::text = ANY (${list}::text[])
          ORDER BY r.id FOR UPDATE OF r
        `
      : 'teamId' in scope
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT r.id FROM team_join_requests r
            WHERE r.team_id = ${scope.teamId}::uuid AND r.status::text = ANY (${list}::text[])
            ORDER BY r.id FOR UPDATE OF r
          `
        : await tx.$queryRaw<Array<{ id: string }>>`
            SELECT r.id FROM team_join_requests r JOIN teams t ON t.id = r.team_id
            WHERE t.org_id = ${scope.orgId}::uuid AND r.status::text = ANY (${list}::text[])
            ORDER BY r.id FOR UPDATE OF r
          `;
  return rows.map((row) => row.id);
}
