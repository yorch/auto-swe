import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '../types/api.js';

/**
 * Concurrency admission for agent runs.
 *
 * An agent run holds a worker activity slot and a workspace container for its
 * whole wall clock, and the worker has one small slot pool shared with every
 * engineering run, eval and channel task. A few launches can therefore stall
 * the platform, so the number in flight is capped globally and per team.
 *
 * The gateway checks this for a friendly 429; the WORKER checks it again, and
 * the worker is the authority: other launch paths reach the same template, and
 * two simultaneous launches both pass a gateway-side count. Admission is
 * therefore a deterministic RANK, not a count-then-start race: of the runs in
 * flight, the oldest `limit` are admitted and a newer one is refused. Two
 * racing launches at limit 1 cannot both proceed, and cannot both be refused.
 */

export interface AgentRunSlot {
  /** `ActiveWorkflow.temporalWorkflowId` */
  workflowId: string;
  /** Owning team of the repository; null when unknown. */
  teamId: string | null;
  /** `RunInput.createdAt`, the launch order. */
  launchedAt: Date;
}

export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: 'disabled' | 'global_limit' | 'team_limit' | 'unknown_run' };

export interface AdmissionLimits {
  /** `workspace.agentRunMaxConcurrentGlobal`; 0 disables agent runs. */
  global: number;
  /** `workspace.agentRunMaxConcurrentPerTeam` for the run's team; 0 disables. */
  perTeam: number;
}

const order = (a: AgentRunSlot, b: AgentRunSlot): number =>
  a.launchedAt.getTime() - b.launchedAt.getTime() || a.workflowId.localeCompare(b.workflowId);

/**
 * `inFlight` is every non-terminal agent run, INCLUDING `self`. Worker side:
 * the run asks whether it is among the oldest `limit` in flight.
 */
export function decideAdmission(
  inFlight: readonly AgentRunSlot[],
  self: { workflowId: string; teamId: string | null },
  limits: AdmissionLimits
): AdmissionDecision {
  if (limits.global <= 0 || limits.perTeam <= 0) {
    return { admitted: false, reason: 'disabled' };
  }
  const sorted = [...inFlight].sort(order);
  const globalRank = sorted.findIndex((r) => r.workflowId === self.workflowId);
  if (globalRank === -1) {
    // Fail closed: a run that cannot find itself cannot show it was admitted.
    return { admitted: false, reason: 'unknown_run' };
  }
  if (globalRank >= limits.global) {
    return { admitted: false, reason: 'global_limit' };
  }
  const sameTeam = sorted.filter((r) => r.teamId === self.teamId);
  const teamRank = sameTeam.findIndex((r) => r.workflowId === self.workflowId);
  if (teamRank >= limits.perTeam) {
    return { admitted: false, reason: 'team_limit' };
  }
  return { admitted: true };
}

/** Gateway-side: would one more run for `teamId` fit? */
export function wouldAdmitNewRun(
  inFlight: readonly AgentRunSlot[],
  teamId: string | null,
  limits: AdmissionLimits
): AdmissionDecision {
  if (limits.global <= 0 || limits.perTeam <= 0) {
    return { admitted: false, reason: 'disabled' };
  }
  if (inFlight.length >= limits.global) {
    return { admitted: false, reason: 'global_limit' };
  }
  if (inFlight.filter((r) => r.teamId === teamId).length >= limits.perTeam) {
    return { admitted: false, reason: 'team_limit' };
  }
  return { admitted: true };
}

/** The slice of a Prisma client the loader needs, so the gateway and worker share it. */
interface ActiveWorkflowReader {
  activeWorkflow: {
    findMany: (args: {
      select: {
        currentStatus: true;
        temporalWorkflowId: true;
        repository: { select: { teamId: true } };
        workRequest: { select: { createdAt: true } };
      };
      where: { currentStatus: { notIn: string[] }; workRequest: { templateId: string } };
    }) => Promise<
      Array<{
        currentStatus: string;
        temporalWorkflowId: string;
        repository: { teamId: string } | null;
        workRequest: { createdAt: Date } | null;
      }>
    >;
  };
}

/** Every non-terminal run of the system template, as admission slots. */
export async function loadAgentRunSlots(
  db: ActiveWorkflowReader,
  systemTemplateId: string
): Promise<AgentRunSlot[]> {
  const rows = await db.activeWorkflow.findMany({
    select: {
      currentStatus: true,
      repository: { select: { teamId: true } },
      temporalWorkflowId: true,
      workRequest: { select: { createdAt: true } },
    },
    // Filtered in the database: the template's history grows without bound,
    // and only what is still running can hold a slot.
    where: {
      currentStatus: { notIn: [...ACTIVE_WORKFLOW_TERMINAL_STATUSES] },
      workRequest: { templateId: systemTemplateId },
    },
  });
  return rows.map((r) => ({
    launchedAt: r.workRequest?.createdAt ?? new Date(0),
    teamId: r.repository?.teamId ?? null,
    workflowId: r.temporalWorkflowId,
  }));
}
