import crypto from 'node:crypto';
import { isLaunchableAgentKey } from '@auto-swe/shared/lib/agentRun';
import { RUN_PLAN_MODES, type RunPlanMode } from '@auto-swe/shared/lib/plannedRun';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import { runPlanGenerationWorkflowId } from '@auto-swe/shared/lib/runPlanWorkflows';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { JwtPayload } from '../plugins/auth.js';
import type { RunPlanJobState } from '../plugins/temporal.js';
import { uuidFromIdempotencyKey, workflowIdFromIdempotencyKey } from './idempotency.js';
import { launchableAgentKeys } from './launchableAgents.js';
import { releaseGenerationSlot, reserveGenerationSlot } from './runPlanQuotas.js';
import {
  authorizeRepository,
  type PlanRefusal,
  refuse,
  requireEngineer,
} from './runPlanService.js';

/**
 * Starting a plan-generation job: the one function behind `POST /run-plans` and the Slack
 * "Generate plan" button, so both take identical decisions. Order of checks:
 *
 * 1. the person is an active ENGINEER (read from the database, never from a token);
 * 2. the repository: reach, GitHub permission, org membership and cap, host allowlist;
 * 3. the library agent (output-only plans): launchable, and active for the repository's organization;
 * 4. the Idempotency-Key: a retry finds its job (or is refused when it names another goal);
 * 5. the kill switch, the hourly generation limit and the pending-plan cap, with the audit row that
 *    counts the generation, written in one transaction;
 * 6. the workflow start, which gives the slot back when the job never started.
 *
 * The caller names a goal, a repository and (for an output-only plan) an agent. The mode, the
 * launchable agent keys and every limit are computed here. No intent text reaches a log or an error.
 */

/** What a generation workflow carries in its memo (see `RunPlanGenerationMemo`). */
export const RunPlanMemoSchema = z.object({
  intentHash: z.string(),
  mode: z.enum(RUN_PLAN_MODES),
  ownerUserId: z.string(),
  repoId: z.string().uuid(),
  teamId: z.string(),
});

export const user8Of = (userId: string) => userId.replace(/-/g, '').slice(0, 8);

/** The plan a job becomes: derived from the job id, so persisting twice finds one row. */
export function planIdForJob(userId: string, jobId: string): string {
  return uuidFromIdempotencyKey(`run-plan:${userId}`, jobId);
}

export function runPlanIntentHash(
  repoId: string,
  agent: string | undefined,
  intent: string
): string {
  return crypto
    .createHash('sha256')
    .update(`${repoId}\n${agent ?? ''}\n${intent}`)
    .digest('hex');
}

export interface StartRunPlanArgs {
  /** The person the plan belongs to. Never a service principal; the caller guarantees that. */
  user: JwtPayload;
  repoId: string;
  /** The goal, already trimmed and validated against `runPlanIntentIssue`. */
  intent: string;
  /** A library agent key; present means an output-only plan built on it. */
  agent?: string | undefined;
  idempotencyKey?: string | undefined;
  /** Where the request came from; recorded on the generation's audit row. */
  source?: 'slack' | undefined;
}

export interface StartRunPlanDeps {
  gate?: RepoAccessGate | undefined;
  log?: FastifyBaseLogger | undefined;
}

export type StartRunPlanResult = { ok: true; jobId: string; deduplicated: boolean } | PlanRefusal;

export async function startRunPlan(
  fastify: FastifyInstance,
  deps: StartRunPlanDeps,
  args: StartRunPlanArgs
): Promise<StartRunPlanResult> {
  const { agent, idempotencyKey, intent, repoId, source, user } = args;
  const serviceDeps = { gate: deps.gate, log: deps.log, prisma: fastify.prisma };

  const engineer = await requireEngineer(serviceDeps, { sub: user.sub });
  if (!engineer.ok) {
    return engineer;
  }

  // Repository reach, GitHub permission, org membership and cap, host allowlist: the launch
  // decision, the same function the plan service re-runs at creation and approval.
  const repo = await authorizeRepository(serviceDeps, { sub: user.sub }, repoId);
  if (!repo.ok) {
    return repo;
  }
  const scope = { orgId: repo.repo.orgId, teamId: repo.repo.teamId };

  // The agents the plan may name: the agent-run rules, computed here and never taken from
  // the client. A library-agent plan must be built on one of them.
  const agentKeys = await launchableAgentKeys(fastify.prisma, scope.orgId);
  if (agent !== undefined) {
    if (!isLaunchableAgentKey(agent)) {
      return refuse(
        400,
        'AGENT_NOT_LAUNCHABLE',
        `Agent '${agent}' backs a platform mechanism and cannot be launched`
      );
    }
    if (!agentKeys.includes(agent)) {
      return refuse(
        404,
        'AGENT_NOT_FOUND',
        `No active agent '${agent}' at global or organization scope`
      );
    }
  }
  const mode: RunPlanMode = agent ? 'output-only' : 'delivering';
  const hash = runPlanIntentHash(repoId, agent, intent);

  const jobId = idempotencyKey
    ? workflowIdFromIdempotencyKey('runplan', user8Of(user.sub), idempotencyKey)
    : runPlanGenerationWorkflowId(`${user8Of(user.sub)}-${crypto.randomUUID().replace(/-/g, '')}`);

  const replay = (state: RunPlanJobState): StartRunPlanResult => {
    const memo = RunPlanMemoSchema.safeParse('memo' in state ? state.memo : {});
    // Another person's job under a colliding id is not described to this caller.
    if (!memo.success || memo.data.ownerUserId !== user.sub) {
      return refuse(
        409,
        'IDEMPOTENCY_KEY_CONFLICT',
        'This Idempotency-Key cannot be used; send a new one'
      );
    }
    if (memo.data.intentHash !== hash) {
      return refuse(
        422,
        'IDEMPOTENCY_KEY_MISMATCH',
        'This Idempotency-Key was already used for a different request. Use a new key for a different goal.'
      );
    }
    return { deduplicated: true, jobId, ok: true };
  };

  const planId = planIdForJob(user.sub, jobId);
  if (idempotencyKey) {
    const existing = await fastify.temporal.getRunPlanJob(jobId);
    if (existing.status !== 'not_found') {
      return replay(existing);
    }
    // The job's history is gone but the plan it made is not: the plan id is a function of the
    // key, so starting again would hand the caller that old plan (launched, rejected or for
    // another goal) as if it were the answer to this request.
    const prior = await fastify.prisma.runPlan.findUnique({
      select: { id: true },
      where: { id: planId },
    });
    if (prior) {
      return refuse(
        422,
        'IDEMPOTENCY_KEY_MISMATCH',
        'This Idempotency-Key already produced a plan, so it cannot start another. Use a new key.'
      );
    }
  }

  const reservation = await reserveGenerationSlot(fastify, {
    jobId,
    mode,
    planId,
    repoId,
    scope,
    ...(source ? { source } : {}),
    user,
  });
  if (!reservation.ok) {
    return reservation;
  }
  const { auditId } = reservation;
  try {
    const { started } = await fastify.temporal.startRunPlanGeneration(
      jobId,
      {
        ...(agent ? { agentKey: agent } : {}),
        intent,
        launchableAgentKeys: agentKeys,
        mode,
        orgId: scope.orgId,
        teamId: scope.teamId,
      },
      { intentHash: hash, mode, ownerUserId: user.sub, repoId, teamId: scope.teamId }
    );
    if (!started) {
      // A retry that raced its own first request: this call started nothing, so it gives back
      // its own row. The request that did start the job holds the row that pays for it.
      await releaseGenerationSlot(fastify, { auditId, userId: user.sub });
      return replay(await fastify.temporal.getRunPlanJob(jobId));
    }
  } catch (err) {
    // A start that failed on this side may still have reached Temporal (a timeout after the
    // server accepted it). Take the row back only once the job is shown not to exist.
    let startedAnyway = true;
    try {
      startedAnyway = (await fastify.temporal.getRunPlanJob(jobId)).status !== 'not_found';
    } catch {
      // Cannot prove it did not start: keep the row.
    }
    if (!startedAnyway) {
      await releaseGenerationSlot(fastify, { auditId, userId: user.sub });
    }
    throw err;
  }
  return { deduplicated: false, jobId, ok: true };
}
