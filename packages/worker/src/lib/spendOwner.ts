import { AsyncLocalStorage } from 'node:async_hooks';
import { configCacheTtlMs, withCache } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { activityInfo } from '@temporalio/activity';

/**
 * The team and organization an LLM call's spend belongs to. Written onto every
 * `AgentTrace` row so usage can be broken down and filtered by tenant without
 * re-deriving it through run → request → connection, which a workflow with no
 * run cannot do at all.
 */
export interface SpendOwner {
  teamId?: string;
  orgId?: string;
}

type Team = { id: string; orgId: string } | null | undefined;

const fromTeam = (team: Team): SpendOwner => (team ? { orgId: team.orgId, teamId: team.id } : {});

const explicitOwner = new AsyncLocalStorage<Promise<SpendOwner>>();

/**
 * Runs `fn` with its spend attributed to `owner`.
 *
 * For workflows that keep no run or ledger row — authoring, scheduled evals,
 * lesson consolidation, dependency inference — the workflow id leads nowhere,
 * and only the activity knows whose work it is doing. Takes a promise so the
 * lookup runs beside the activity rather than ahead of it; a failed lookup
 * attributes to nobody, never fails the activity.
 */
export function withSpendOwner<T>(owner: Promise<SpendOwner>, fn: () => Promise<T>): Promise<T> {
  return explicitOwner.run(
    owner.catch(() => ({})),
    fn
  );
}

/** The owner of a team's work. */
export async function ownerOfTeam(teamId: string | null | undefined): Promise<SpendOwner> {
  if (!teamId) {
    return {};
  }
  return fromTeam(
    await prisma.team.findUnique({ select: { id: true, orgId: true }, where: { id: teamId } })
  );
}

/** The owner of work on a connection: its owning team. */
export async function ownerOfConnection(connectionId: string): Promise<SpendOwner> {
  const connection = await prisma.connection.findUnique({
    select: { team: { select: { id: true, orgId: true } } },
    where: { id: connectionId },
  });
  return fromTeam(connection?.team);
}

/** The owner of an eval dataset: its team, else its organization, else nobody (GLOBAL). */
export async function ownerOfDataset(datasetId: string): Promise<SpendOwner> {
  const dataset = await prisma.evalDataset.findUnique({
    select: { orgId: true, teamId: true },
    where: { id: datasetId },
  });
  if (dataset?.teamId) {
    return ownerOfTeam(dataset.teamId);
  }
  return dataset?.orgId ? { orgId: dataset.orgId } : {};
}

/**
 * The owner of the current activity's spend: what the activity declared through
 * {@link withSpendOwner}, else what its workflow's rows say, else nobody.
 *
 * Derived the way run visibility decides a run's team: the run's own
 * repository (an epic child), its ledger row's repository, its work request's
 * connection, its Slack channel, then its template. Never throws — attribution
 * is bookkeeping, and a call that has been paid for must still be recorded.
 */
export async function currentSpendOwner(): Promise<SpendOwner> {
  const explicit = explicitOwner.getStore();
  if (explicit) {
    return explicit;
  }
  let workflowId: string | undefined;
  try {
    workflowId = activityInfo().workflowExecution?.workflowId;
  } catch {
    // Outside an activity: nothing to attribute to.
  }
  if (!workflowId) {
    return {};
  }
  try {
    return await withCache(
      `spend-owner:${workflowId}`,
      configCacheTtlMs(),
      () => ownerOfWorkflow(workflowId),
      // A lookup that raced ahead of the run's rows must not pin "nobody".
      (owner) => owner.teamId !== undefined
    );
  } catch {
    return {};
  }
}

async function ownerOfWorkflow(workflowId: string): Promise<SpendOwner> {
  const team = { select: { id: true, orgId: true } } as const;
  const [run, ledger] = await Promise.all([
    prisma.workflowRun.findUnique({
      select: {
        channel: { select: { team } },
        connection: { select: { team } },
        template: { select: { team } },
        workRequest: { select: { connection: { select: { team } } } },
      },
      where: { workflowId },
    }),
    prisma.activeWorkflow.findUnique({
      select: { repository: { select: { team } } },
      where: { temporalWorkflowId: workflowId },
    }),
  ]);
  return fromTeam(
    run?.connection?.team ??
      ledger?.repository?.team ??
      run?.workRequest?.connection?.team ??
      run?.channel?.team ??
      run?.template?.team
  );
}
