/**
 * Whether the run executing right now may use a connection.
 *
 * A spec can name a connection **literally** — an `mcp` node's `connectionRef` is an id
 * written into the template, not a payload binding — and no launch path authorizes it.
 * Without a check where the connection is used, a team's template can name another
 * team's MCP connection and call tools on that server with that team's token: the save
 * -time reference check (`gateway/src/lib/specRefValidation.ts`) looks the id up across
 * every team on purpose, to tell an author that the connection exists, and only warns.
 *
 * The authority is the run's template, read from the run rather than taken from the
 * caller, so every use site applies the same rule to the same values: a team's template
 * may use a connection that team owns or has had shared with it, and a global
 * (admin-authored) template may use any (`templateReachesConnection`).
 */
import { prisma } from '@auto-swe/shared/db';
import { isRepoTeam, templateReachesConnection } from '@auto-swe/shared/lib/repoMembership';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { logWarn } from './activityLog.js';
import type { ResolveCtx } from './config/types.js';

/** The workflow execution's id, or null outside an activity. */
function currentWorkflowId(): string | null {
  try {
    return Context.current().info.workflowExecution?.workflowId ?? null;
  } catch {
    return null;
  }
}

const NOT_AUTHORIZED =
  'it is not one of the connections this run was authorized to use. Supply it as a ' +
  '`connection` field of the template you launched, or ask an admin to add it to the template.';

/**
 * Refuse a connection the run was not authorized to use.
 *
 * The run's authorized set is resolved once, when it is created (`createWorkflowRun`) from
 * the template's declared `connection` fields, the payload, and the run's own connection,
 * and pinned on the row. Checking membership is what makes the declared schema a boundary:
 * a connection named through a field the schema does not describe was never authorized, so
 * it is not in the set, whichever node resolved it — including one whose value came from
 * another node's output.
 *
 * Fails closed on an unreadable pin. A run with **no pin** is let through with a warning:
 * it was created before the column existed, so there is nothing to check against, and
 * refusing would strand work mid-flight. Every new execution writes one.
 */
export async function assertConnectionAuthorized(
  connectionId: string,
  step: string
): Promise<void> {
  const workflowId = currentWorkflowId();
  const run = workflowId
    ? await prisma.workflowRun.findUnique({
        select: { authorizedConnectionIds: true, id: true },
        where: { workflowId },
      })
    : null;
  if (!run) {
    throw ApplicationFailure.nonRetryable(
      `Step '${step}' may not use connection '${connectionId}': the run it belongs to could not be identified.`,
      'RUN_NOT_IDENTIFIED',
      { connectionId, step }
    );
  }
  const pinned = run.authorizedConnectionIds;
  if (pinned === null || pinned === undefined) {
    logWarn('a run has no authorized-connection pin; its connections are unchecked', {
      connectionId,
      runId: run.id,
      step,
    });
    return;
  }
  if (!Array.isArray(pinned) || !pinned.includes(connectionId)) {
    throw ApplicationFailure.nonRetryable(
      `Step '${step}' may not use connection '${connectionId}': ${NOT_AUTHORIZED}`,
      'CONNECTION_NOT_AUTHORIZED',
      { connectionId, step }
    );
  }
}

/**
 * Refuse a connection this run's template may not use.
 *
 * Fails closed: a run that cannot be identified is refused rather than allowed, because
 * "we could not tell whose template this is" is not a reason to hand over a credential.
 * That includes a run whose template row is gone: an absent template must not read as a
 * *global* one, which is the case that may use any connection. The message names the node
 * and the connection but does not say whether the connection exists or who owns it — a
 * caller that guessed an id learns nothing from the refusal.
 */
export async function assertRunMayUseConnection(connectionId: string, step: string): Promise<void> {
  const workflowId = currentWorkflowId();
  const [run, connection] = await Promise.all([
    workflowId
      ? prisma.workflowRun.findUnique({
          select: { template: { select: { teamId: true } } },
          where: { workflowId },
        })
      : null,
    prisma.connection.findUnique({
      select: { isActive: true, shares: { select: { teamId: true } }, teamId: true },
      where: { id: connectionId },
    }),
  ]);
  if (!run?.template || !connection?.isActive) {
    throw ApplicationFailure.nonRetryable(
      `Step '${step}' may not use connection '${connectionId}': it is not reachable from this run.`,
      'CONNECTION_NOT_REACHABLE',
      { connectionId, step }
    );
  }
  if (!templateReachesConnection(connection, run.template.teamId)) {
    throw ApplicationFailure.nonRetryable(
      `Step '${step}' may not use connection '${connectionId}': it is not reachable from this run.`,
      'CONNECTION_NOT_REACHABLE',
      { connectionId, step }
    );
  }
}

/** What an Agent's MCP connection is checked against: the run's team, else its template's team. */
export type AgentConnectionTenant = Pick<ResolveCtx, 'teamId' | 'workflowTemplateId'>;

/** How {@link agentMayUseConnection} answered: `check_failed` is a lookup error, not a verdict. */
export type AgentConnectionAccess = 'allowed' | 'refused' | 'check_failed';

/**
 * Whether this run's tenant may use the `mcp` connection an Agent binds (`Agent.mcpConnectionId`).
 *
 * The binding is chosen on the Agent row, not by the run or its template's author, and a GLOBAL or
 * organization-scope row applies to every team's runs: without this, a platform-wide agent bound
 * to one team's server would call it, with that team's token and reach, from any other team's run
 * — steered by whatever prompt that run supplies. So the only authority is a team, and that team
 * must own the connection (`isRepoTeam`, which would also count a share, though MCP connections
 * cannot be shared):
 *
 * - With a team in the tenant (the run's repository's team, or a channel's), that team is checked.
 * - With no team but a template, the template's own team is checked. A global template has no
 *   team, and is refused: unlike an `mcp` node's `connectionRef`, the id was not written by the
 *   template's (admin) author, and any member may launch a global template.
 * - With neither, nothing identifies a team, and it is refused.
 *
 * A missing, inactive or non-`mcp` connection is `allowed`: there is nothing to refuse, and
 * `mcpUrlForConnection` binds nothing for it. Never throws: a lookup that fails answers
 * `check_failed`, so the caller degrades without reading the connection's credential.
 */
export async function agentMayUseConnection(
  connectionId: string,
  tenant?: AgentConnectionTenant
): Promise<AgentConnectionAccess> {
  try {
    const connection = await prisma.connection.findUnique({
      select: { isActive: true, shares: { select: { teamId: true } }, teamId: true, type: true },
      where: { id: connectionId },
    });
    if (!connection?.isActive || connection.type !== 'mcp') {
      return 'allowed';
    }
    let teamId: string | null | undefined = tenant?.teamId;
    if (!teamId && tenant?.workflowTemplateId) {
      const template = await prisma.workflowTemplate.findUnique({
        select: { teamId: true },
        where: { id: tenant.workflowTemplateId },
      });
      teamId = template?.teamId;
    }
    return teamId && isRepoTeam(connection, teamId) ? 'allowed' : 'refused';
  } catch {
    return 'check_failed';
  }
}
