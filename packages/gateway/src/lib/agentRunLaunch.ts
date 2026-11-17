import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { resolveSettings } from '@auto-swe/shared/config';
import {
  AGENT_REF_RE,
  AGENT_RUN_DELIVERIES,
  AGENT_RUN_MAX_PROMPT_CHARS,
  AGENT_RUN_TEMPLATE_NAME,
  AGENT_RUN_TEMPLATE_ORIGIN,
  type AgentRunPayload,
  AgentRunPayloadSchema,
  agentRunTicketId,
  isLaunchableAgentKey,
} from '@auto-swe/shared/lib/agentRun';
import {
  closeAgentRunLedgerRows,
  loadAgentRunSlots,
  reconcileAgentRunSlots,
  wouldAdmitNewRun,
} from '@auto-swe/shared/lib/agentRunAdmission';
import { repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import { isGitRepoConnection } from '@auto-swe/shared/lib/connectionGuards';
import { type EgressPolicy, egressPolicySchema } from '@auto-swe/shared/lib/egressPolicy';
import { BaseBranchSchema, isPlatformWorkBranch } from '@auto-swe/shared/lib/gitRef';
import { isOrchestrationRefusalCode } from '@auto-swe/shared/lib/orchestration';
import { type CallbackRequest, CallbackRequestSchema } from '@auto-swe/shared/lib/runCallbacks';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { generateBranchName } from '@auto-swe/shared/lib/workflowId';
import {
  BUDGET_TIERS,
  type BudgetTier,
  type RepoWorkRequest,
} from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteCaller } from '../plugins/auth.js';
import { egressPolicyForRerun, refuseWideningEgressPolicy } from './egressPolicyLaunch.js';
import { sendError } from './httpErrors.js';
import { workflowIdFromIdempotencyKey } from './idempotency.js';
import { KnowledgeBaseOverridesSchema, validateKnowledgeBaseOverrides } from './knowledgeBases.js';
import { assertMcpWriteAllowed, sendRunCapRefusal } from './mcpWriteGuard.js';
import { authorizeTeamLaunch } from './orchestrationAccess.js';
import {
  callbackScopeForCaller,
  resolveLaunchCallback,
  sendCallbackRefusal,
} from './runCallbackLaunch.js';
import { validateRunConnection } from './runConnection.js';
import { latestRunIdForWorkRequest, runProvenance } from './runProvenance.js';
import {
  idempotencyCallerScope,
  sendServiceLaunchRefusal,
  servicePrincipalLaunchGuard,
} from './servicePrincipals.js';
import { launchTrackedWorkflow } from './workflowLaunch.js';

/**
 * The agent-run launch pipeline, shared by `POST /api/v1/agent-runs`, its re-run route and the
 * orchestration child-launch route (`routes/orchestrations.ts`).
 *
 * A launch is a `WorkflowRun` of the hidden "Agent Run" system template. What this pipeline
 * checks is for good error messages; the WORKER re-checks every bound that matters (template
 * identity, payload, non-launchable agents, ceilings, concurrency), because the template is
 * reachable from other launch paths and nothing here can be assumed to have run.
 */

export const CreateAgentRunBody = z.object({
  /** Library agent: `<key>` (float) or `<key>@<version>` (pin the GLOBAL version). */
  agent: z.string().min(1).max(130).regex(AGENT_REF_RE),
  /** Branch to cut the checkout from and open a draft PR into. Unset: the default branch. */
  baseBranch: BaseBranchSchema.optional(),
  budgetTier: z.enum(BUDGET_TIERS).default('STANDARD'),
  /** Where to report the run's outcome (docs/run-callbacks.md). */
  callback: CallbackRequestSchema.optional(),
  /** `none` shows the diff, `branch` pushes a branch, `draft_pr` also opens a DRAFT pull request. */
  deliver: z.enum(AGENT_RUN_DELIVERIES).default('none'),
  /** Network egress for this run's containers; can only be stricter than the configured policy. */
  egressPolicy: egressPolicySchema.optional(),
  knowledgeBases: KnowledgeBaseOverridesSchema.optional(),
  /** Can only lower the platform ceiling. */
  maxSteps: z.number().int().min(1).max(500).optional(),
  maxWallClockSeconds: z.number().int().min(60).max(14_400).optional(),
  prompt: z.string().min(1).max(AGENT_RUN_MAX_PROMPT_CHARS),
  repoId: z.string().uuid(),
});
export type CreateAgentRunBody = z.infer<typeof CreateAgentRunBody>;
const AgentRunReplayInput = CreateAgentRunBody.omit({ callback: true }).partial({ repoId: true });

/**
 * The agent rows an agent run may resolve: GLOBAL, and the repository's
 * ORGANIZATION. One definition for the launch check and the picker, so the
 * list never offers an agent the launch would then refuse to find.
 */
export function agentScopeBranches(orgId: string | null) {
  return [
    { channelId: null, scope: 'GLOBAL' as const, teamId: null, workflowTemplateId: null },
    { orgId, scope: 'ORGANIZATION' as const },
  ];
}

export function splitRef(ref: string): { key: string; version: number | undefined } {
  const at = ref.lastIndexOf('@');
  return at === -1
    ? { key: ref, version: undefined }
    : { key: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return sendError(reply, status, code, message);
}

/** The columns of the target repository the launch and the push-permission lookup read. */
export interface LaunchRepoRow {
  githubApiUrl: string | null;
  githubUrl: string | null;
  id: string;
  installation: { host: string; installationId: string } | null;
  organizationName: string | null;
  repoName: string | null;
  scmProvider: string;
  team: { orgId: string };
  teamId: string;
  type: string;
}

/** A refusal a seam hook returns; sent as the launch's error, with orchestration codes as 409. */
export interface SeamRefusal {
  code: string;
  message: string;
  status?: number;
}

/**
 * What an orchestration adds to a launch of one of its children. Every hook is optional except
 * the ones that write the child's row; a direct agent run passes none of this.
 */
export interface OrchestrationChildSeam {
  orchestrationId: string;
  /** The orchestrator's workflow id, stored as the child ledger row's parent. */
  parentWorkflowId: string;
  /** Validated path scopes of a writer; empty for a reader. They also travel in the run payload. */
  pathScopes: string[];
  /**
   * A child of a repo-less orchestration: no repository, charged to this team. The launcher must
   * belong to the team (checked here, as a repository launch checks membership).
   */
  repoless?: { teamId: string };
  /** Runs once the target repository is authorized, before the agent is resolved. */
  checkRepo?: (repo: LaunchRepoRow) => Promise<SeamRefusal | null>;
  /**
   * Writes the child's row inside the ledger transaction (after the work request and ledger row).
   * Throws to abort the whole launch; the throw reaches the caller of the launcher.
   */
  inTransaction: (
    tx: Prisma.TransactionClient,
    ids: { temporalWorkflowId: string; workRequestId: string }
  ) => Promise<void>;
  /** An existing child already launched under this deterministic workflow id (a retried spawn). */
  existing: (temporalWorkflowId: string) => Promise<Record<string, unknown> | null>;
  /** Removes the child row when the workflow never started, ahead of the ledger compensation. */
  onStartFailed: (workRequestId: string) => Promise<void>;
  /** The success body, in place of the agent-run launch response. */
  respond: (launched: { temporalWorkflowId: string; workRequestId: string }) => unknown;
}

export interface LaunchInput {
  knowledgeBases?: z.infer<typeof KnowledgeBaseOverridesSchema>;
  agent: string;
  baseBranch?: string;
  budgetTier: BudgetTier;
  /** A fresh launch only; a re-run reuses its request and reports nowhere. */
  callback?: CallbackRequest;
  deliver: AgentRunPayload['deliver'];
  egressPolicy?: EgressPolicy;
  /** A re-run: the stored `egressPolicy` is held to today's cascade value instead of refused. */
  egressPolicyIsRerun?: boolean;
  idempotencyKey: string | undefined;
  maxSteps?: number;
  maxWallClockSeconds?: number;
  /** Set only by the orchestration child-launch route. */
  orchestration?: OrchestrationChildSeam;
  prompt: string;
  /** Required unless `orchestration.repoless` names the team instead. */
  repoId?: string;
  /**
   * Who launches: a person, whom the run acts as (`launchedById`), or a service principal, whose
   * run uses the platform credential and is attributed to it (`requestedByServiceId`).
   */
  caller: RouteCaller;
  /** Re-runs keep their request identity while allocating a fresh delivery branch. */
  workRequestId?: string;
}

/** The settings both the early refusal and the launch read for an agent run's team. */
const ADMISSION_SETTING_KEYS = [
  'workspace.agentRunMaxSteps',
  'workspace.agentRunMaxWallClockSeconds',
  'workspace.agentRunMaxConcurrentGlobal',
  'workspace.agentRunMaxConcurrentPerTeam',
] as const;

/**
 * Authorize a caller against a repository for an agent run: the launch decision every agent run
 * takes (membership in the owning or a shared team, GitHub permission under the access gate, the
 * organization's monthly cap, a service principal's allowlist), then that the connection is a git
 * repository on an approved host. Returns the repository row, or null after sending the refusal.
 */
export async function authorizeAgentRunRepo(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  input: { caller: RouteCaller; repoId: string }
): Promise<LaunchRepoRow | null> {
  const { caller } = input;
  const user = caller.kind === 'user' ? caller.user : null;
  const service = caller.kind === 'service' ? caller.principal : undefined;
  const connection = await validateRunConnection(
    {
      connectionId: input.repoId,
      gate: request.repoAccessGate,
      log: request.log,
      prisma: fastify.prisma,
      providerMeta: null,
      ...(service ? { service } : {}),
      templateTeamId: null,
      user,
    },
    reply
  );
  if (!connection.ok) {
    return null;
  }

  const repo = await fastify.prisma.connection.findUnique({
    select: {
      githubApiUrl: true,
      githubUrl: true,
      id: true,
      installation: { select: { host: true, installationId: true } },
      organizationName: true,
      repoName: true,
      scmProvider: true,
      team: { select: { orgId: true } },
      teamId: true,
      type: true,
    },
    where: { id: input.repoId },
  });
  if (!repo) {
    error(reply, 404, 'CONNECTION_NOT_FOUND', 'Connection not found or inactive');
    return null;
  }
  if (!isGitRepoConnection(repo)) {
    error(reply, 400, 'NOT_A_GIT_REPO', 'Agent runs need a git repository');
    return null;
  }
  // Every credential is sent to these URLs; refuse early and clearly. The
  // worker's SCM layer checks again at the point of sending.
  const hosts = await repositoryHostsAllowed({
    githubApiUrl: repo.githubApiUrl,
    githubUrl: repo.githubUrl,
  });
  if (!hosts.ok) {
    error(
      reply,
      422,
      'REPO_HOST_NOT_ALLOWED',
      `This repository's host is not on the approved repository hosts (${hosts.url})`
    );
    return null;
  }
  return repo as LaunchRepoRow;
}

export function createAgentRunLauncher(fastify: FastifyInstance) {
  /**
   * The launch pipeline shared by a fresh launch and a re-run, so a re-run
   * re-validates everything (the agent may have been deactivated, a ceiling
   * lowered, the caller's access revoked) instead of replaying a stored decision.
   */
  return async function launch(request: FastifyRequest, reply: FastifyReply, input: LaunchInput) {
    const orch = input.orchestration;
    // An orchestration's refusals use its own vocabulary and status (409); everything else keeps
    // the agent-run launch's status.
    const refuse = (status: number, code: string, message: string) => {
      if (orch && isOrchestrationRefusalCode(code)) {
        return reply.status(409).send({ code, error: { code, message }, message });
      }
      return error(reply, status, code, message);
    };
    const mcpWrite = await assertMcpWriteAllowed(request, reply, {
      submit: { budgetTier: input.budgetTier, idempotencyKey: input.idempotencyKey },
      tool: 'start_agent_run',
    });
    if (mcpWrite.refused) {
      return mcpWrite.refused;
    }
    if (request.mcpBridge) {
      const settings = await resolveSettings(['mcp.agentRunAllowedDeliverModes']);
      if (!settings['mcp.agentRunAllowedDeliverModes'].includes(input.deliver)) {
        return error(
          reply,
          403,
          'MCP_DELIVER_MODE_NOT_ALLOWED',
          'This delivery mode is not allowed through MCP'
        );
      }
    }
    const { caller } = input;
    const user = caller.kind === 'user' ? caller.user : null;
    const service = caller.kind === 'service' ? caller.principal : undefined;
    const { key, version } = splitRef(input.agent);

    if (!isLaunchableAgentKey(key)) {
      return error(
        reply,
        400,
        'AGENT_NOT_LAUNCHABLE',
        `Agent '${key}' backs a platform mechanism and cannot be launched as an agent run`
      );
    }

    // Authorisation: repository access (owning OR shared team), GitHub
    // permission, the caller as the run's identity, the org's monthly cap. A
    // service principal instead needs the repository on its allowlist and
    // reachable by its team, and the org under its cap. A repo-less child of an
    // orchestration is held to the named team instead.
    let repo: LaunchRepoRow | null = null;
    let target: { orgId: string; teamId: string };
    if (orch?.repoless) {
      if (!user) {
        return refuse(403, 'REPO_REQUIRED', 'A service principal cannot run a repo-less child');
      }
      const team = await authorizeTeamLaunch(fastify.prisma, reply, {
        gate: request.repoAccessGate,
        log: request.log,
        teamId: orch.repoless.teamId,
        user,
      });
      if (!team) {
        return;
      }
      target = team;
    } else {
      if (!input.repoId) {
        return error(reply, 400, 'REPO_REQUIRED', 'A repository is required');
      }
      repo = await authorizeAgentRunRepo(fastify, request, reply, {
        caller,
        repoId: input.repoId,
      });
      if (!repo) {
        return;
      }
      target = { orgId: repo.team.orgId, teamId: repo.teamId };
      const refusal = orch?.checkRepo ? await orch.checkRepo(repo) : null;
      if (refusal) {
        return refuse(refusal.status ?? 403, refusal.code, refusal.message);
      }
    }
    const orgId = target.orgId;

    // The agent must exist where this run can resolve it. A shared-team member
    // launches here, so the owning team's TEAM-scope agents do not apply:
    // GLOBAL and the repository's ORGANIZATION only (the worker resolves the same way).
    const agents = await runUnscoped(
      'an agent run resolves its agent at GLOBAL and ORGANIZATION scope only',
      ['Agent'],
      () =>
        fastify.prisma.agent.findMany({
          select: { scope: true, version: true },
          where: { isActive: true, key, OR: agentScopeBranches(orgId) },
        })
    );
    const found =
      version === undefined
        ? agents.length > 0
        : // A pin applies to the GLOBAL lineage only.
          agents.some((a) => a.scope === 'GLOBAL' && a.version === version);
    if (!found) {
      return error(
        reply,
        404,
        'AGENT_NOT_FOUND',
        version === undefined
          ? `No active agent '${key}' at global or organization scope`
          : `No active global agent '${key}' at version ${version}`
      );
    }

    // The worker resolves ORGANIZATION before GLOBAL, and a version pin only
    // applies to GLOBAL, so with an active ORG override the run would execute
    // the org's latest version, not the one the caller named. Refuse rather
    // than run a different agent than the one asked for.
    if (version !== undefined && agents.some((a) => a.scope === 'ORGANIZATION')) {
      return error(
        reply,
        400,
        'AGENT_PIN_SHADOWED',
        `'${key}' has an active organization-scope override, which a version pin cannot select; ` +
          'launch it without @version to run the override'
      );
    }

    // Ceilings and the kill switch. A launch can only lower a ceiling.
    const settings = await resolveSettings([...ADMISSION_SETTING_KEYS], {
      orgId,
      teamId: target.teamId,
    });
    const ceilings = {
      maxSteps: settings['workspace.agentRunMaxSteps'],
      maxWallClockSeconds: settings['workspace.agentRunMaxWallClockSeconds'],
    };
    if (input.maxSteps !== undefined && input.maxSteps > ceilings.maxSteps) {
      return error(
        reply,
        400,
        'CAP_EXCEEDS_CEILING',
        `maxSteps ${input.maxSteps} is above the platform ceiling of ${ceilings.maxSteps}`
      );
    }
    if (
      input.maxWallClockSeconds !== undefined &&
      input.maxWallClockSeconds > ceilings.maxWallClockSeconds
    ) {
      return error(
        reply,
        400,
        'CAP_EXCEEDS_CEILING',
        `maxWallClockSeconds ${input.maxWallClockSeconds} is above the platform ceiling of ${ceilings.maxWallClockSeconds}`
      );
    }

    const template = await fastify.prisma.workflowTemplate.findFirst({
      select: { activeVersion: true, id: true },
      where: {
        name: AGENT_RUN_TEMPLATE_NAME,
        origin: AGENT_RUN_TEMPLATE_ORIGIN,
        status: 'ACTIVE',
        teamId: null,
      },
    });
    if (!template?.activeVersion) {
      return error(
        reply,
        503,
        'AGENT_RUN_TEMPLATE_MISSING',
        'The Agent Run system template is not installed; run the database seed'
      );
    }

    const knowledgeBaseOverrides = repo
      ? await validateKnowledgeBaseOverrides(
          fastify.prisma,
          reply,
          { orgId, repoId: repo.id, teamId: target.teamId, templateId: template.id },
          input.knowledgeBases
        )
      : undefined;
    if (knowledgeBaseOverrides === false) {
      return;
    }
    const requestPayload = JSON.stringify(AgentRunReplayInput.parse(input));
    // The key's scope: the repository, or for a repo-less child the named team.
    const scope8 = (repo?.id ?? target.teamId).replace(/-/g, '').slice(0, 8);
    const caller8 = idempotencyCallerScope(caller);
    const temporalWorkflowId = input.idempotencyKey
      ? workflowIdFromIdempotencyKey('agent', `${scope8}-${caller8}`, input.idempotencyKey)
      : `agent-${scope8}-${crypto.randomUUID().replace(/-/g, '')}`;
    const replay = async () => {
      if (orch) {
        // A retried spawn: the child the first attempt launched is the answer.
        const existing = await orch.existing(temporalWorkflowId);
        return existing ? { reply: reply.status(200).send(existing) } : null;
      }
      if (!request.mcpBridge) {
        return null;
      }
      const previous = await fastify.prisma.activeWorkflow.findUnique({
        select: {
          workRequest: { select: { requestedById: true, requestPayload: true } },
          workRequestId: true,
        },
        where: { temporalWorkflowId },
      });
      if (!previous?.workRequest || previous.workRequest.requestedById !== user?.sub) {
        return null;
      }
      let storedInput: unknown;
      try {
        storedInput = JSON.parse(previous.workRequest.requestPayload);
      } catch {
        storedInput = null;
      }
      const prior = AgentRunReplayInput.safeParse(storedInput);
      if (!prior.success || JSON.stringify(prior.data) !== requestPayload) {
        return {
          reply: error(
            reply,
            422,
            'IDEMPOTENCY_KEY_MISMATCH',
            'This Idempotency-Key was already used for a different request. Use a new key for different agent-run inputs.'
          ),
        };
      }
      return {
        reply: reply.send({ data: { deduplicated: true, workRequestId: previous.workRequestId } }),
      };
    };
    const previous = await replay();
    if (previous) {
      return previous.reply;
    }

    // A launch may narrow the network egress policy for its run, never widen it. The worker pins
    // the narrowed value; this is the early, readable refusal.
    const egressScope = { orgId, teamId: target.teamId, workflowTemplateId: template.id };
    let egressPolicy = input.egressPolicy;
    if (input.egressPolicyIsRerun) {
      // A re-run keeps the original's choice but never loosens a cascade tightened since: the
      // stricter of the two runs, rather than a refusal the launcher cannot act on.
      egressPolicy = await egressPolicyForRerun(input.egressPolicy, egressScope);
    } else if (await refuseWideningEgressPolicy(reply, input.egressPolicy, egressScope)) {
      return reply;
    }
    const networkPolicies = await resolveSettings(
      ['workspace.egressPolicy', 'workspace.setupEgressPolicy'],
      {
        orgId: orgId ?? undefined,
        teamId: target.teamId ?? undefined,
        workflowTemplateId: template.id,
      }
    );

    // Concurrency. Friendly early refusal; the worker admits by rank and is the authority.
    // A ledger row only holds a slot while its workflow is still running in
    // Temporal; one whose workflow is gone is closed here (bounded, and kept
    // counting when Temporal cannot be asked). Charged to the repository's owning team, or the
    // named team for a repo-less child.
    const liveSlots = await reconcileAgentRunSlots(
      await loadAgentRunSlots(fastify.prisma, template.id),
      {
        close: closeAgentRunLedgerRows(fastify.prisma),
        isRunning: async (workflowId) => !(await fastify.temporal.isWorkflowGone(workflowId)),
        onClosed: (workflowIds) =>
          fastify.log.warn(
            { workflowIds },
            'closed agent run ledger rows whose workflow is no longer running'
          ),
        onUnreachable: (workflowId, err) =>
          fastify.log.warn(
            { err, workflowId },
            'could not confirm an agent run is finished; it keeps its concurrency slot'
          ),
      }
    );
    const admission = wouldAdmitNewRun(liveSlots, target.teamId, {
      global: settings['workspace.agentRunMaxConcurrentGlobal'],
      perTeam: settings['workspace.agentRunMaxConcurrentPerTeam'],
    });
    if (!admission.admitted) {
      return admission.reason === 'disabled'
        ? error(reply, 403, 'AGENT_RUNS_DISABLED', 'Agent runs are disabled for this team')
        : orch
          ? refuse(
              429,
              'AGENT_RUN_CONCURRENCY_EXCEEDED',
              admission.reason === 'team_limit'
                ? "This team's agent runs are at their concurrency limit; try again when one finishes"
                : 'Agent runs are at the platform concurrency limit; try again when one finishes'
            )
          : error(
              reply,
              429,
              'AGENT_RUN_CONCURRENCY_EXCEEDED',
              admission.reason === 'team_limit'
                ? "This team's agent runs are at their concurrency limit; try again when one finishes"
                : 'Agent runs are at the platform concurrency limit; try again when one finishes'
            );
    }

    // Launch parameters travel in RunInput.payload; the worker re-parses them.
    const payload: AgentRunPayload = AgentRunPayloadSchema.parse({
      agentRef: input.agent,
      ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
      deliver: input.deliver,
      ...(egressPolicy ? { egressPolicy } : {}),
      maxSteps: input.maxSteps,
      maxWallClockSeconds: input.maxWallClockSeconds,
      ...(orch
        ? {
            orchestrationId: orch.orchestrationId,
            ...(orch.pathScopes.length > 0 ? { pathScopes: orch.pathScopes } : {}),
          }
        : {}),
    });
    const attemptId = crypto.randomUUID();
    const workRequestId = input.workRequestId ?? attemptId;
    const externalTicketId = agentRunTicketId(attemptId);
    // The key is scoped to the caller as well as the repo: two callers who pick the
    // same key on one repo must not collide, and a 409 must not reveal the other's run.
    const { branchPrefix } = await resolveWorkflowDefaults();
    if (input.baseBranch && isPlatformWorkBranch(input.baseBranch, branchPrefix)) {
      return error(
        reply,
        400,
        'INVALID_BASE_BRANCH',
        `baseBranch '${input.baseBranch}' is a platform work branch; a run may not be based on one`
      );
    }
    // The callback is checked before anything is written; it is stored sealed beside the
    // request, never in `requestPayload` (its query may carry the receiver's token).
    const callback = await resolveLaunchCallback(fastify.prisma, {
      callback: input.callback,
      ...callbackScopeForCaller(fastify.prisma, input.caller),
      workflowId: temporalWorkflowId,
    });
    if (!callback.ok) {
      return sendCallbackRefusal(reply, callback);
    }
    const repoWorkRequest: RepoWorkRequest = {
      budgetTier: input.budgetTier,
      ...(repo ? { connectionId: repo.id } : {}),
      description: input.prompt,
      ...(egressPolicy ? { egressPolicy } : {}),
      externalTicketId,
      // A person's run acts as, and uses the saved GitHub credential of, its
      // launcher. A service principal's uses the platform credential.
      ...(user ? { launchedById: user.sub } : {}),
      payload,
      ...(orch ? { parentWorkflowId: orch.parentWorkflowId } : {}),
      repoId: repo?.id ?? null,
      requestPayload,
      workRequestId,
      workspaceProvider: 'git_repo',
      ...(knowledgeBaseOverrides ? { knowledgeBaseOverrides } : {}),
      ...runProvenance({
        actor: user,
        // A re-run names the work request it repeats; the run it repeats is that request's latest.
        rerunOfRunId: input.workRequestId
          ? await latestRunIdForWorkRequest(fastify.prisma, input.workRequestId, fastify.log)
          : undefined,
        serviceId: service?.servicePrincipalId,
        trigger: service ? 'service-token' : 'agent-run',
        ...(orch ? { triggerRefId: orch.orchestrationId } : {}),
      }),
    };

    // Ledger rows first, workflow second, rolled back if the start fails. The
    // ActiveWorkflow row is mandatory: the worker derives the run's team and
    // org (settings, concurrency, budget) from it.
    const result = await launchTrackedWorkflow(
      fastify.prisma,
      {
        activeWorkflow: {
          assignedBranch:
            input.deliver === 'none' ? null : generateBranchName(externalTicketId, branchPrefix),
          budgetTier: input.budgetTier,
          currentStatus: 'IMPLEMENTING',
          ...(orch ? { parentWorkflowId: orch.parentWorkflowId } : {}),
          repoId: repo?.id ?? null,
          temporalWorkflowId,
          workRequestId,
        },
        ...(repo
          ? {
              knowledgeSourceRepo: {
                orgId: repo.team.orgId,
                repoId: repo.id,
                teamId: repo.teamId,
              },
            }
          : { knowledgeSourceTeam: { orgId: target.orgId, teamId: target.teamId } }),
        ...(input.workRequestId
          ? {}
          : {
              runInput: {
                // A repo-less child is charged to the named team, as a connection-less run is.
                ...(repo
                  ? { connectionId: repo.id }
                  : { billingOrgId: target.orgId, billingTeamId: target.teamId }),
                description: input.prompt,
                externalTicketId,
                id: workRequestId,
                payload: payload as object,
                requestedById: user?.sub ?? null,
                requestedByServiceId: service?.servicePrincipalId ?? null,
                requestPayload,
                templateId: template.id,
                templateVersion: template.activeVersion,
                // `agent-<id>` is generated here, not a tracker ticket.
                ticketIsSynthetic: true,
                ...(callback.create ? { callback: { create: callback.create } } : {}),
              },
            }),
      },
      async () => {
        try {
          await fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
            request: repoWorkRequest,
            templateId: template.id,
            templateVersion: template.activeVersion as number,
          });
        } catch (err) {
          // The child row points at the work request the compensation is about to delete.
          if (orch) {
            await orch.onStartFailed(workRequestId).catch((cleanupErr: unknown) => {
              fastify.log.error(
                { cleanupErr, workRequestId },
                'orchestration child cleanup failed'
              );
            });
          }
          throw err;
        }
      },
      {
        ...(service
          ? {
              guard: servicePrincipalLaunchGuard(service.servicePrincipalId, {
                connectionId: repo?.id ?? null,
              }),
            }
          : { guard: mcpWrite.launchGuard }),
        audit: {
          actor: user ?? null,
          ...(egressPolicy ? { egressPolicy } : {}),
          source: orch ? 'orchestration-child' : service ? 'service-token' : 'agent-run',
        },
        ...(orch
          ? {
              inTransaction: (tx: Prisma.TransactionClient) =>
                orch.inTransaction(tx, { temporalWorkflowId, workRequestId }),
            }
          : {}),
        log: fastify.log,
        sourceAuthorization: user ? { actor: user } : {},
      }
    );
    if (!result.ok) {
      const raced = await replay();
      if (raced) {
        return raced.reply;
      }
      if (result.reason === 'GUARD_REFUSED') {
        if (request.mcpBridge) {
          return sendRunCapRefusal(reply);
        }
        return sendServiceLaunchRefusal(reply, result.refusal);
      }
      return error(reply, 409, 'RUN_CONFLICT', 'A run with this idempotency key already exists');
    }
    if (orch) {
      return reply.status(201).send(orch.respond({ temporalWorkflowId, workRequestId }));
    }
    return reply.status(201).send({
      data: {
        // Where the outcome will be reported: origin and path, never the query.
        ...(callback.target ? { callback: { target: callback.target } } : {}),
        effective: {
          deliver: payload.deliver,
          egressPolicy: egressPolicy ?? networkPolicies['workspace.egressPolicy'],
          maxSteps: Math.min(payload.maxSteps ?? ceilings.maxSteps, ceilings.maxSteps),
          maxWallClockSeconds: Math.min(
            payload.maxWallClockSeconds ?? ceilings.maxWallClockSeconds,
            ceilings.maxWallClockSeconds
          ),
          setupEgressPolicy: networkPolicies['workspace.setupEgressPolicy'],
        },
        temporalWorkflowId,
        workflowId: result.activeWorkflowId,
        workRequestId,
      },
    });
  };
}
