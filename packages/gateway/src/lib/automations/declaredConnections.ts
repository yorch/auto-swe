/**
 * Whether an acting team may hand one of its runs every connection a payload it built names.
 *
 * The run pins the connections its **payload** declares, so the pin cannot answer this: it
 * authorizes whatever the payload says. A launch path that calls `validateRunConnection`
 * decides it up front; a path with no user of its own — an automation fire — must decide it
 * here, or the run spends a credential nobody authorized.
 *
 * The rule is the acting **team's** reach (`isRepoTeam`: owns it, or has it shared).
 * `templateReachesConnection` is deliberately not used: its global-template branch answers
 * `true` for any connection, which is sound for a literal id an ADMIN wrote into a spec's
 * `connectionRef`, and a bypass for a *payload binding* — chosen by a team LEAD filling in a
 * form, or by an inbound event's named fields. `resolveAutomationTemplate` accepts a template
 * whose `teamId` is null or the team's, so that exemption would be reached on the common path.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { declaredConnectionInputs, isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import { isInstallationRetired } from '@auto-swe/shared/lib/repoAccessDecision';
import { isRepoTeam } from '@auto-swe/shared/lib/repoMembership';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

/**
 * The refusal to record, or null when every declared connection is one the team can use.
 *
 * The message names the offending *field* and nothing else — not the owning team, not whether
 * the connection exists — so a payload naming a guessed id learns nothing from the refusal.
 *
 * A template with no readable schema declares no connection, so there is nothing to decide here:
 * the run's pin is computed from the same value and declares none either, and a node that
 * resolves one anyway is refused where it is used.
 */
export async function declaredConnectionProblem(args: {
  prisma: PrismaClient;
  inputSchema: unknown;
  payload: unknown;
  teamId: string;
  /**
   * The run's own connection, already decided by the caller: it is not looked up or re-decided,
   * exactly as `authorizeDeclaredConnections` skips its `repeatsPrimary` field. Its *declared
   * type* is still checked, against {@link primaryConnectionType} — the type the caller already
   * loaded — because a launch refuses that mismatch and a fire must not be more permissive.
   */
  primaryConnectionId?: string | null;
  primaryConnectionType?: string | null;
}): Promise<string | null> {
  if (!isInputSchema(args.inputSchema)) {
    return null;
  }
  const declared = declaredConnectionInputs(args.inputSchema, args.payload);
  const others = declared.filter((field) => field.connectionId !== args.primaryConnectionId);
  // Unscoped on purpose: the ids come from the payload, and the question is whether the acting
  // team reaches them — `isRepoTeam` below is that decision. A tenant filter would answer a
  // different question (what this scope can see) and would refuse a connection shared with the team.
  const rows =
    others.length === 0
      ? []
      : await runUnscoped(
          'a payload names connections by id; reach is decided by isRepoTeam below',
          ['Connection'],
          () =>
            args.prisma.connection.findMany({
              select: {
                id: true,
                installation: { select: { host: true, installationId: true, isActive: true } },
                isActive: true,
                shares: { select: { teamId: true } },
                teamId: true,
                type: true,
              },
              where: { id: { in: others.map((field) => field.connectionId) } },
            })
        );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const { connectionId, expectedType, field } of declared) {
    if (connectionId === args.primaryConnectionId) {
      if (expectedType && expectedType !== args.primaryConnectionType) {
        return `'${field}' expects a ${expectedType} connection`;
      }
      continue;
    }
    const row = byId.get(connectionId);
    // Inactive refuses too: the run could not load it, and a fire that cannot start should
    // say so now rather than fail inside the worker with the same information.
    if (!row?.isActive || !isRepoTeam(row, args.teamId)) {
      return `the connection in '${field}' is not one this team can use`;
    }
    // The same two refusals a launch makes on a declared connection: a retired GitHub
    // installation, and a connection whose type contradicts the field's declaration.
    if (isInstallationRetired(row)) {
      return `the repository in '${field}' has a retired GitHub installation`;
    }
    if (expectedType && row.type !== expectedType) {
      return `'${field}' expects a ${expectedType} connection but names a ${row.type}`;
    }
  }
  return null;
}
