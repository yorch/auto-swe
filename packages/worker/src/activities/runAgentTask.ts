import { resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import {
  AGENT_RUN_MAX_OUTPUT_DIFF_CHARS,
  AGENT_RUN_MAX_TEXT_CHARS,
  AGENT_RUN_TEMPLATE_NAME,
  AGENT_RUN_TEMPLATE_ORIGIN,
  AgentRunPayloadSchema,
  clampToCeiling,
  isLaunchableAgentKey,
} from '@auto-swe/shared/lib/agentRun';
import { decideAdmission } from '@auto-swe/shared/lib/agentRunAdmission';
import { executorImageFor } from '@auto-swe/shared/lib/executorImage';
import { PreviewConfigSchema } from '@auto-swe/shared/lib/previewConfig';
import { clampPullRequestTitle } from '@auto-swe/shared/lib/pullRequest';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { workBranchOf } from '@auto-swe/shared/lib/workflowId';
import type { FileChange, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';
import {
  grantedWorkspaceToolIds,
  grantsBrowserTool,
  selectAgentRunTools,
} from '../agents/agentRunTools.js';
import { BrowserToolset, createMastraBrowserTools } from '../agents/browserTools.js';
import type { BoundHarness } from '../agents/harness/registry.js';
import { HARNESSES } from '../agents/harnessRegistry.js';
import { runImplementerTurn } from '../agents/implementerRuntime.js';
import { buildKnowledgeTools } from '../agents/knowledgeTools.js';
import { loadMcpTools } from '../agents/mcpTools.js';
import { buildWorkspaceTools } from '../agents/workspaceTools.js';
import { currentWorkflowId, persistActivityTrace } from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import { loadLiveAgentRunSlots } from '../lib/agentRunSlots.js';
import { AgentTracer, redactString } from '../lib/agentTracer.js';
import { boundToolKeys } from '../lib/boundToolKeys.js';
import { parseAgentRef } from '../lib/config/agentRef.js';
import { type ResolvedAgent, resolveAgent } from '../lib/config/agentResolver.js';
import { resolveAgentRuntime } from '../lib/config/agentRuntime.js';
import { type AgentTools, composeAgentPrompt, resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import type { ModelBackedAgentKey, ResolveCtx } from '../lib/config/types.js';
import { assertBudgetAvailable } from '../lib/costTracking.js';
import { throwIfActivityCancelled, withHeartbeat } from '../lib/execUtils.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { resolveRunBaseBranch } from '../lib/runBaseBranch.js';
import { withRunDetection } from '../lib/runDetection.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { DraftPullRequestUnsupportedError } from '../lib/scm/types.js';
import { assertModelPricedForUsdCap } from '../lib/usdCapGuard.js';
import {
  commitTrustedTree,
  gateTrustedCommit,
  importAgentTree,
  pushGatedCommit,
} from './agentRunFinalize.js';
import { runAgent } from './runAgent.js';
import { parseDiffToFileChanges } from './utils.js';
import { createWorkspace, shellQuote, type Workspace } from './workspace.js';

export interface RunAgentTaskInput {
  /** The run's request: `payload` carries the launch parameters, `description` the prompt. */
  request: RepoWorkRequest;
}

export interface RunAgentTaskResult {
  agent: string;
  /** The agent's final text, redacted and truncated. */
  text: string;
  stoppedReason?: 'max_steps' | 'wall_clock';
  deliver: 'none' | 'branch' | 'draft_pr';
  /** The change as a diff, capped. For `deliver: none` it is the agent's own view and unverified. */
  diff: string;
  diffTruncated: boolean;
  /** False when the diff came from the agent's container rather than the trusted one. */
  diffVerified: boolean;
  filesChanged: FileChange[];
  /** What happened at the gate: `passed` (published), `no_changes`, or `not_applicable` (deliver none). */
  gate: 'passed' | 'no_changes' | 'not_applicable';
  codeSecurityFindingCount: number;
  baseSha: string;
  branch?: string;
  headSha?: string;
  prNumber?: number;
  prUrl?: string;
  effective: { maxSteps: number; maxWallClockSeconds: number };
  steps?: number;
  costUsd?: number;
}

const TICKET_RE = /^agent-[0-9a-f]{32}$/;

function refuse(message: string, type: string, details?: unknown): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, type, ...(details ? [details] : []));
}

/**
 * The internal step behind the hidden "Agent Run" system template: run one
 * library agent against one repository, optionally publishing what it wrote.
 *
 * It is the AUTHORITY for everything an agent run may do. The gateway checks the
 * same things for good error messages, but this template is reachable from other
 * launch paths (`/workflow-templates/:id/runs`, Slack, schedules, webhooks,
 * bundles), so nothing here assumes the gateway ran. Single attempt: a retry
 * would re-spend and could re-publish.
 */
export async function runAgentTask(input: RunAgentTaskInput): Promise<RunAgentTaskResult> {
  return withHeartbeat('runAgentTask', runAgentTaskImpl(input));
}

/**
 * What every caller hands the shared agent-run core: which agent (resolved at GLOBAL and
 * ORGANIZATION scope), on which repository, what the prompt and the branch pair are, which
 * ceilings were already decided, and whether the gated commit is pushed.
 */
export interface AgentTaskCoreInput {
  /** The `git_repo` connection row, with its installation. */
  repo: Parameters<typeof toRepoRef>[0] & {
    detectedStack?: unknown;
    executorImage?: string | null;
    teamId: string | null;
  };
  /** The library agent key (already checked `isLaunchableAgentKey`). */
  key: string;
  /** The version the run pinned, when one was. */
  version?: number;
  /** The run's agent/skill pinning, carried into the resolve context. */
  agentVersions?: ResolveCtx['agentVersions'];
  skillRevisions?: ResolveCtx['skillRevisions'];
  /** The tenant context the run resolved: ceilings and MCP scoping come from it. */
  baseCtx: ResolveCtx;
  effective: { maxSteps: number; maxWallClockSeconds: number };
  prompt: string;
  /** The branch the checkout is cut from and a fix is diffed against. */
  baseBranch: string;
  /** The branch the gated commit is pushed to. */
  branch: string;
  /** The commit message of the gated commit. */
  commitMessage: string;
  /** `push` delivers through the fresh trusted container; `none` reports the agent's own diff. */
  deliver: 'push' | 'none';
  /** Whether the gate lets the agent touch workflow files. */
  allowWorkflowChanges: boolean;
  /**
   * Runs inside the core's try after a pushed commit, before the trace persists — the caller's
   * publish step (the agent run's draft pull request). Never called for `deliver: 'none'` or
   * a `no_changes` result.
   */
  afterPush?: (args: {
    branch: string;
    filesChanged: FileChange[];
    findingsCount: number;
    headSha: string;
    stoppedReason?: 'max_steps' | 'wall_clock';
    text: string;
    tracer: AgentTracer;
  }) => Promise<void>;
}

export interface AgentTaskCoreResult {
  agent: string;
  baseSha: string;
  branch?: string;
  codeSecurityFindingCount: number;
  costUsd?: number;
  diff: string;
  diffTruncated: boolean;
  diffVerified: boolean;
  effective: { maxSteps: number; maxWallClockSeconds: number };
  filesChanged: FileChange[];
  gate: 'passed' | 'no_changes' | 'not_applicable';
  headSha?: string;
  steps?: number;
  stoppedReason?: 'max_steps' | 'wall_clock';
  text: string;
}

/**
 * The core of an agent task: resolve the agent (GLOBAL + ORGANIZATION only — the caller's
 * team must never shape it), pick its runtime, run it in a container it cannot push from,
 * then commit and gate what it wrote in a FRESH container and push the gated commit.
 * Who may call it at all is each caller's own check.
 */
export async function runAgentTaskCore(input: AgentTaskCoreInput): Promise<AgentTaskCoreResult> {
  const {
    key,
    version,
    baseCtx,
    effective,
    prompt,
    baseBranch,
    branch,
    commitMessage,
    deliver,
    allowWorkflowChanges,
  } = input;
  // Its callers load the row; the stack the run began with is read here, once, for both
  // workspaces below.
  const repo = await withRunDetection(input.repo);
  const settingsCtx: ResolveCtx = { orgId: baseCtx.orgId, teamId: baseCtx.teamId };
  const settings = await resolveSettings(
    ['workspace.agentRunAllowWorkflowChanges', 'workspace.maxToolOutputChars'],
    settingsCtx
  );
  const agentCtx: ResolveCtx = {
    agentVersions: {
      ...(baseCtx.agentVersions ?? {}),
      ...(version !== undefined ? { [key]: version } : {}),
    },
    orgId: baseCtx.orgId,
    skillRevisions: baseCtx.skillRevisions,
  };
  const resolved = await resolveAgent(key, agentCtx);
  // Before any container exists: an unpriced model under a USD cap is refused
  // here rather than after a clone (runAgent checks again before the call).
  await assertModelPricedForUsdCap(resolved.model.spec);
  const loop = await resolveAgentRuntime(key, agentCtx, 'mastra');
  const harness =
    loop.runtime === 'mastra'
      ? undefined
      : HARNESSES.select(loop.runtime).bind(key, resolved.model);

  const repoRef = toRepoRef(repo);
  const scm = getScmProvider(repoRef);
  const { authedCloneUrl } = await scm.cloneCredentials(repoRef);
  let services: ReturnType<typeof PreviewConfigSchema.parse>['services'];
  if (grantsBrowserTool(resolved.toolKeys)) {
    const previewRow = await prisma.connection.findUnique({
      select: { previewConfig: true },
      where: { id: repo.id },
    });
    services = previewRow?.previewConfig
      ? PreviewConfigSchema.parse(previewRow.previewConfig).services
      : undefined;
  }

  const tracer = new AgentTracer();
  let agentWs: Workspace | undefined;
  let trusted: Workspace | undefined;
  let closeMcp: (() => Promise<void>) | undefined;
  try {
    // The agent's container is cloned with the credential (a private repo needs
    // it) but the credential is never written into it: origin is the clean URL
    // and only `gitAuthed` injects the header, which the agent run never calls
    // on this workspace.
    agentWs = await createWorkspace(
      authedCloneUrl,
      branch,
      baseBranch,
      executorImageFor(repo),
      undefined,
      undefined,
      { detectedStack: repo.detectedStack, services, teamId: repo.teamId }
    );
    const baseSha = (await agentWs.exec('git rev-parse HEAD')).trim();

    tracer.addActivityEvent({
      name: 'agent.runtime',
      outputJson: { agentKey: key, runtime: loop.runtime, source: loop.source },
    });
    const loopInput: AgentLoopInput = {
      agentCtx,
      deadline: AbortSignal.timeout(effective.maxWallClockSeconds * 1000),
      key,
      maxSteps: effective.maxSteps,
      maxToolOutputChars: settings['workspace.maxToolOutputChars'],
      prompt,
      repoId: input.repo.id,
      resolved,
      settingsCtx,
      tracer,
      workspace: agentWs,
    };
    const result = harness
      ? await runOnHarness(loopInput, harness)
      : await runOnMastra(loopInput, (close) => {
          closeMcp = close;
        });
    const text = redactString(result.text ?? '').slice(0, AGENT_RUN_MAX_TEXT_CHARS);
    const base: Omit<
      AgentTaskCoreResult,
      | 'diff'
      | 'diffTruncated'
      | 'diffVerified'
      | 'filesChanged'
      | 'gate'
      | 'codeSecurityFindingCount'
    > = {
      agent: key,
      baseSha,
      costUsd: result.costUsd,
      effective,
      steps: result.steps,
      stoppedReason: result.stoppedReason,
      text,
    };
    if (deliver === 'none') {
      const raw = await agentDiff(agentWs, baseSha);
      return {
        ...base,
        ...capDiff(raw),
        codeSecurityFindingCount: 0,
        diffVerified: false,
        filesChanged: capFilesChanged(parseDiffToFileChanges(raw)),
        gate: 'not_applicable',
      };
    }

    // Delivery: judge and publish from a FRESH container the agent never ran in.
    throwIfActivityCancelled();
    trusted = await createWorkspace(
      authedCloneUrl,
      branch,
      baseBranch,
      executorImageFor(repo),
      baseSha,
      undefined,
      { detectedStack: repo.detectedStack, teamId: repo.teamId }
    );
    await importAgentTree(agentWs, trusted);
    const committed = await commitTrustedTree(trusted, baseSha, commitMessage);
    if (committed.empty) {
      return {
        ...base,
        codeSecurityFindingCount: 0,
        diff: '',
        diffTruncated: false,
        diffVerified: true,
        filesChanged: [],
        gate: 'no_changes',
      };
    }
    const gated = await gateTrustedCommit(trusted, {
      allowWorkflowChanges:
        allowWorkflowChanges && settings['workspace.agentRunAllowWorkflowChanges'],
      baseSha,
      sha: committed.sha,
      tracer,
    });
    await pushGatedCommit(trusted, gated, branch);
    tracer.addActivityEvent({
      name: 'git.commit_push',
      outputJson: { branch, headSha: gated.sha },
    });
    await input.afterPush?.({
      branch,
      filesChanged: gated.filesChanged,
      findingsCount: gated.codeSecurityFindings.length,
      headSha: gated.sha,
      stoppedReason: result.stoppedReason,
      text,
      tracer,
    });
    return {
      ...base,
      branch,
      codeSecurityFindingCount: gated.codeSecurityFindings.length,
      headSha: gated.sha,
      ...capDiff(gated.diff),
      diffVerified: true,
      filesChanged: capFilesChanged(gated.filesChanged),
      gate: 'passed',
    };
  } finally {
    await closeMcp?.();
    await persistActivityTrace(tracer, resolved.key);
    // The agent workspace never holds the push credential, but both are removed.
    await agentWs?.destroy();
    await trusted?.destroy();
  }
}

async function runAgentTaskImpl({ request }: RunAgentTaskInput): Promise<RunAgentTaskResult> {
  const repoId = requireRepoId(request, 'runAgentTask');
  const workflowId = currentWorkflowId();

  // ── 1. Only the system template may run this, against the repo its ledger row names.
  const run = await prisma.workflowRun.findUnique({
    select: { template: { select: { name: true, origin: true, teamId: true } }, templateId: true },
    where: { workflowId },
  });
  if (
    !run ||
    run.template.origin !== AGENT_RUN_TEMPLATE_ORIGIN ||
    run.template.name !== AGENT_RUN_TEMPLATE_NAME ||
    run.template.teamId !== null
  ) {
    throw refuse(
      'runAgentTask is an internal step of the Agent Run system template',
      'AGENT_RUN_NOT_SYSTEM_TEMPLATE'
    );
  }
  const ledger = await prisma.activeWorkflow.findFirst({
    select: { id: true, repoId: true, temporalWorkflowId: true },
    where: { temporalWorkflowId: workflowId },
  });
  if (!ledger?.repoId || ledger.repoId !== repoId) {
    throw refuse(
      'The run does not name the repository its ledger row names',
      'AGENT_RUN_REPO_MISMATCH'
    );
  }

  // ── 2. The launch parameters, re-validated here.
  const parsed = AgentRunPayloadSchema.safeParse(request.payload);
  if (!parsed.success) {
    throw refuse(`Invalid agent run payload: ${parsed.error.message}`, 'AGENT_RUN_INVALID_PAYLOAD');
  }
  const payload = parsed.data;
  const { key, version } = parseAgentRef(payload.agentRef);
  if (!isLaunchableAgentKey(key)) {
    throw refuse(`Agent '${key}' cannot be launched as an agent run`, 'AGENT_NOT_LAUNCHABLE');
  }
  if (!TICKET_RE.test(request.externalTicketId)) {
    throw refuse(
      'Agent runs publish under their own agent-<id> branch names',
      'AGENT_RUN_INVALID_PAYLOAD'
    );
  }

  // ── 3. Ceilings, kill switch and concurrency, from the platform's settings.
  const baseCtx = await currentRequestContext();
  // The template can never override a ceiling: the cascade is read with the
  // owning team and org only.
  const settingsCtx: ResolveCtx = { orgId: baseCtx.orgId, teamId: baseCtx.teamId };
  const settings = await resolveSettings(
    [
      'workspace.agentRunMaxSteps',
      'workspace.agentRunMaxWallClockSeconds',
      'workspace.agentRunMaxConcurrentGlobal',
      'workspace.agentRunMaxConcurrentPerTeam',
      'workspace.agentRunAllowWorkflowChanges',
      'workspace.maxToolOutputChars',
    ],
    settingsCtx
  );
  const admission = decideAdmission(
    await loadLiveAgentRunSlots(run.templateId, workflowId),
    { teamId: baseCtx.teamId ?? null, workflowId },
    {
      global: settings['workspace.agentRunMaxConcurrentGlobal'],
      perTeam: settings['workspace.agentRunMaxConcurrentPerTeam'],
    }
  );
  if (!admission.admitted) {
    throw refuse(
      admission.reason === 'disabled'
        ? 'Agent runs are disabled for this team'
        : `Too many agent runs are in flight (${admission.reason})`,
      admission.reason === 'disabled' ? 'AGENT_RUNS_DISABLED' : 'AGENT_RUN_CONCURRENCY_EXCEEDED'
    );
  }
  const effective = {
    maxSteps: clampToCeiling(payload.maxSteps, settings['workspace.agentRunMaxSteps']),
    maxWallClockSeconds: clampToCeiling(
      payload.maxWallClockSeconds,
      settings['workspace.agentRunMaxWallClockSeconds']
    ),
  };

  // ── 4. The shared core: resolve the agent at GLOBAL + ORGANIZATION (never the
  // owning team's scope — a member of a team the repo is shared with launches
  // this), run it in its container, gate the commit and push it.
  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { host: true, installationId: true } } },
    where: { id: repoId },
  });
  const workflowDefaults = await resolveWorkflowDefaults();
  const branch = workBranchOf(request, workflowDefaults.branchPrefix);
  // The branch the checkout is cut from and a draft PR targets: the launch's, else the
  // repository's default. Refused before any container exists when it is not one a run
  // may use.
  const baseBranch = await resolveRunBaseBranch(payload.baseBranch, repo);
  let pr: { prNumber: number; prUrl: string } | undefined;
  const repoRef = toRepoRef(repo);
  const scm = getScmProvider(repoRef);
  const core = await runAgentTaskCore({
    agentVersions: baseCtx.agentVersions,
    allowWorkflowChanges: true,
    baseBranch,
    baseCtx,
    branch,
    commitMessage: `auto: agent run ${request.externalTicketId} (${payload.agentRef})`,
    deliver: payload.deliver === 'none' ? 'none' : 'push',
    effective,
    key,
    prompt: request.description,
    repo,
    skillRevisions: baseCtx.skillRevisions,
    version,
    ...(payload.deliver !== 'draft_pr'
      ? {}
      : {
          afterPush: async (pushed) => {
            const title = prTitle(request.description);
            try {
              pr = await scm.createOrUpdatePullRequest({
                baseBranch,
                body: prBody({
                  agent: payload.agentRef,
                  files: pushed.filesChanged,
                  findings: pushed.findingsCount,
                  stoppedReason: pushed.stoppedReason,
                  text: pushed.text,
                  workflowId,
                }),
                draft: true,
                headBranch: branch,
                repo: repoRef,
                title,
              });
            } catch (err) {
              // The branch is already published, and stays so. A repository that cannot
              // hold drafts must never get a ready-for-review PR in its place.
              const unsupported = err instanceof DraftPullRequestUnsupportedError;
              throw refuse(
                unsupported
                  ? `This repository does not support draft pull requests. The branch ${branch} was pushed (${pushed.headSha}); open a pull request from it manually or re-run with deliver=branch.`
                  : `The branch ${branch} was pushed (${pushed.headSha}) but the pull request could not be opened: ${err instanceof Error ? err.message : String(err)}`,
                unsupported ? 'DRAFT_PR_UNSUPPORTED' : 'PR_CREATE_FAILED',
                { branch, headSha: pushed.headSha }
              );
            }
            await recordAgentRunPullRequest(
              {
                headSha: pushed.headSha,
                isDraft: true,
                ledgerId: ledger.id,
                prNumber: pr.prNumber,
                repoId,
                temporalWorkflowId: ledger.temporalWorkflowId,
                title,
              },
              pushed.tracer
            );
          },
        }),
  });

  return {
    ...core,
    agent: payload.agentRef,
    deliver: payload.deliver,
    ...(pr ? { prNumber: pr.prNumber, prUrl: pr.prUrl } : {}),
  };
}

interface AgentLoopInput {
  agentCtx: ResolveCtx;
  /** The run's wall clock: reaching it stops the loop, it does not fail it. */
  deadline: AbortSignal;
  key: string;
  maxSteps: number;
  maxToolOutputChars: number;
  prompt: string;
  resolved: ResolvedAgent;
  settingsCtx: ResolveCtx;
  tracer: AgentTracer;
  repoId: string;
  workspace: Workspace;
}

interface AgentLoopResult {
  costUsd?: number;
  steps?: number;
  stoppedReason?: 'max_steps' | 'wall_clock';
  text?: string;
}

/**
 * The Mastra loop: the workspace tools the Agent's `toolKeys` grant (read tools
 * unless a write tool is NAMED), its MCP server, and every step debited as it
 * lands. `onMcp` hands the MCP client's close to the caller's `finally`.
 */
async function runOnMastra(
  input: AgentLoopInput,
  onMcp: (close: () => Promise<void>) => void
): Promise<AgentLoopResult> {
  const { agentCtx, key, resolved, tracer } = input;
  const built = buildWorkspaceTools(input.workspace, tracer, input.maxToolOutputChars);
  const knowledgeTools = buildKnowledgeTools(tracer);
  const closeFns: Array<() => Promise<void>> = [];
  const browserToolset = grantsBrowserTool(resolved.toolKeys)
    ? new BrowserToolset({
        containerId: input.workspace.containerId,
        repoId: input.repoId,
        tracer,
        workspace: input.workspace,
      })
    : undefined;
  if (browserToolset) {
    closeFns.push(browserToolset.close.bind(browserToolset));
  }
  onMcp(async () => {
    await Promise.allSettled(closeFns.map((close) => close()));
  });
  const spec = await resolveAgentSpec(
    {
      agentKey: key as ModelBackedAgentKey,
      // Knowledge tools are offered only when the Agent names them; resolveAgentSpec
      // intersects offered tools with `toolKeys`, so nothing else binds them.
      availableTools: {
        ...selectAgentRunTools(built, resolved.toolKeys),
        ...(browserToolset ? createMastraBrowserTools(browserToolset) : {}),
        ...(resolved.toolKeys?.includes('searchKnowledge')
          ? { searchKnowledge: knowledgeTools.searchKnowledge }
          : {}),
        ...(resolved.toolKeys?.includes('submitLearning')
          ? { submitLearning: knowledgeTools.submitLearning }
          : {}),
      } as unknown as AgentTools,
      basePrompt: '',
    },
    agentCtx
  );
  spec.systemPrompt = `${spec.systemPrompt}\n\n${WORKSPACE_PREAMBLE}`.trim();

  // MCP per the agent's own configuration (a known exfiltration channel next
  // to a workspace; documented in docs/agent-runs.md). The agent resolves with
  // no team, so the connection is checked against the repository's team.
  const mcpTarget = await resolveAgentMcpUrl(key, agentCtx, { tenant: input.settingsCtx, tracer });
  let mcpTools: AgentTools | undefined;
  if (mcpTarget) {
    const loaded = await loadMcpTools(mcpTarget, tracer);
    closeFns.push(loaded.close);
    mcpTools = loaded.tools as AgentTools;
    spec.tools = { ...loaded.tools, ...spec.tools } as AgentTools;
  }

  throwIfActivityCancelled();
  const result = await runAgent(spec, input.prompt, {
    abortSignal: input.deadline,
    ctx: input.settingsCtx,
    maxSteps: input.maxSteps,
    perStepAccounting: true,
    // The workspace and MCP tools record their own calls on this tracer; any
    // other tool's calls are recorded from the loop's steps.
    selfRecordingTools: boundToolKeys(spec.tools, built, mcpTools),
    spanName: 'llm.agent_run',
    tracer,
  });
  return {
    costUsd: result.costUsd,
    steps: result.stepCount,
    stoppedReason: result.stoppedReason,
    text: result.text,
  };
}

/**
 * The harness the Agent asked for (Claude Code), in the agent's own container, as one turn.
 *
 * It is granted exactly the harness tools that stand in for the workspace
 * tools the Mastra loop would have granted (`grantedWorkspaceToolIds`), never
 * the implementer's "no opinion means everything", and every call goes through
 * the same worker-side policy as an implementer's. The Agent's MCP connection,
 * if it binds one, is relayed to the harness from the worker.
 * Each model call is debited as soon as the harness finishes it and the budget
 * re-checked (`perCallAccounting`), as the Mastra loop debits every step, so an
 * exhausted budget stops the run with `BUDGET_EXCEEDED` after the call in flight.
 */
async function runOnHarness(
  input: AgentLoopInput,
  harness: BoundHarness
): Promise<AgentLoopResult> {
  const { agentCtx, key, resolved, tracer } = input;
  // Prompt and skills come from `resolved`, the resolution the harness is bound to.
  const systemPrompt = composeAgentPrompt(resolved);
  const runtime = harness.build({
    deadline: input.deadline,
    ...(grantsBrowserTool(resolved.toolKeys)
      ? {
          browserToolset: new BrowserToolset({
            containerId: input.workspace.containerId,
            repoId: input.repoId,
            tracer,
            workspace: input.workspace,
          }),
        }
      : {}),
    exactToolKeys: grantedWorkspaceToolIds(resolved.toolKeys),
    loadProjectSettings: true,
    maxTurns: input.maxSteps,
    // The connection the Mastra loop would bind, relayed from the worker.
    mcp: await resolveAgentMcpUrl(key, agentCtx, { tenant: input.settingsCtx, tracer }),
    tracer,
    workspace: input.workspace,
  });

  try {
    throwIfActivityCancelled();
    await assertBudgetAvailable(`agent.${key}`);
    const turn = await runImplementerTurn({
      agent: { id: resolved.id, version: resolved.version },
      boundModelSpec: resolved.model.spec,
      context: { agentRun: true },
      role: key,
      runtime,
      system: `${systemPrompt}\n\n${WORKSPACE_PREAMBLE}`.trim(),
      tracer,
      usageEvent: 'llm.agent_run',
      user: input.prompt,
    });
    return {
      costUsd: turn.attribution.costUsd,
      steps: turn.steps,
      stoppedReason: turn.stoppedReason,
      text: turn.text,
    };
  } finally {
    await runtime.close?.();
  }
}

/**
 * Track the PR on the run's own ledger row, as the workflow's PR step does, so it
 * shows on /pull-requests and the webhook lifecycle finds it. Never fails the run:
 * the PR is already open and the branch pushed, and a retry of this activity would
 * not reuse the open PR (it would be refused as a duplicate). The failure is
 * logged and traced instead, so the run viewer shows it.
 *
 * Always a `create`: the host just opened a new PR, so a row already holding this
 * (repository, number) belongs to a different PR (the repository was repointed or
 * recreated and numbering restarted). The partial unique index refuses the insert,
 * and that other row, with its workflow link and MERGED state, stays untouched.
 */
async function recordAgentRunPullRequest(
  args: {
    headSha: string;
    isDraft: boolean;
    ledgerId: string;
    prNumber: number;
    repoId: string;
    temporalWorkflowId: string;
    title: string;
  },
  tracer: AgentTracer
): Promise<void> {
  try {
    const run = await prisma.workflowRun.findUnique({
      select: { id: true, templateId: true, templateVersion: true },
      where: { workflowId: args.temporalWorkflowId },
    });
    await prisma.pullRequest.create({
      data: {
        ciStatus: 'PENDING',
        headSha: args.headSha,
        isDraft: args.isDraft,
        prNumber: args.prNumber,
        repoId: args.repoId,
        runId: run?.id ?? null,
        status: 'OPEN',
        templateId: run?.templateId ?? null,
        templateVersion: run?.templateVersion ?? null,
        title: clampPullRequestTitle(args.title),
        workflowId: args.ledgerId,
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logWarn('agent run pull request was opened but could not be tracked', {
      error,
      prNumber: args.prNumber,
    });
    tracer.addActivityEvent({
      error,
      name: 'pr.record_failed',
      outputJson: { prNumber: args.prNumber },
    });
  }
}

const WORKSPACE_PREAMBLE = [
  'You are working in a throwaway checkout of the repository, rooted at the current directory.',
  'Use only the tools you were given. Do not run `git commit` or `git push` and do not touch anything under `.git`: when you finish, the platform copies the working tree out, commits it itself and reviews it.',
  'Changes to secrets or credential files, symbolic links, submodules, binary files and CI workflow files are refused when publishing, so do not make them.',
].join('\n');

/** The agent's own diff against the base. Display only: it comes from an untrusted container. */
async function agentDiff(ws: Workspace, baseSha: string): Promise<string> {
  const r = await ws.execCapture(
    `git add -A >/dev/null 2>&1; git diff --cached --text --no-textconv --no-ext-diff --no-color ${shellQuote(baseSha)}`,
    { timeoutMs: 120_000 }
  );
  return r.exitCode === 0 ? r.stdout : '';
}

function capDiff(diff: string): { diff: string; diffTruncated: boolean } {
  if (diff.length <= AGENT_RUN_MAX_OUTPUT_DIFF_CHARS) {
    return { diff, diffTruncated: false };
  }
  return {
    diff: `${diff.slice(0, AGENT_RUN_MAX_OUTPUT_DIFF_CHARS)}\n[diff truncated]`,
    diffTruncated: true,
  };
}

/** Result limits: Temporal rejects a payload over 2 MB, and a failed completion would follow a push. */
const RESULT_MAX_FILES = 200;
const RESULT_MAX_PATH_CHARS = 300;

/** Bound `filesChanged` in count and per-path length (a path is agent-controlled, up to 4 KB). */
function capFilesChanged(files: FileChange[]): FileChange[] {
  return files
    .slice(0, RESULT_MAX_FILES)
    .map((f) =>
      f.path.length > RESULT_MAX_PATH_CHARS
        ? { ...f, path: `${f.path.slice(0, RESULT_MAX_PATH_CHARS)}...` }
        : f
    );
}

/**
 * The changed-file list as one fenced block. A path is agent-controlled, so it
 * must not be able to close a code span, start markdown or an image beacon, or
 * mention anyone: the fence is longer than any backtick run inside it (inline
 * code spans nest nothing), control characters are replaced, and every path is
 * length-capped.
 */
function fencedFileList(files: FileChange[]): string {
  const lines = files.slice(0, 100).map((f) => {
    const safe = Array.from(f.path.slice(0, RESULT_MAX_PATH_CHARS), (ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? '?' : ch;
    }).join('');
    return `${safe} (${f.operation}, +${f.linesAdded}/-${f.linesRemoved})`;
  });
  const longestRun = Math.max(0, ...(lines.join('\n').match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [fence, ...lines.map(neutraliseMentions), fence].join('\n');
}

/** Agent text must not notify people: a zero-width space defuses `@user` and `@org/team` mentions. */
function neutraliseMentions(s: string): string {
  return s.replace(/@/g, '@\u200b');
}

function prTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return `[auto-swe] agent run: ${oneLine.slice(0, 80)}${oneLine.length > 80 ? '...' : ''}`;
}

function prBody(args: {
  agent: string;
  files: FileChange[];
  findings: number;
  stoppedReason?: string;
  text: string;
  workflowId: string;
}): string {
  const list = fencedFileList(args.files);
  return [
    `Opened as a **draft** by an auto-swe agent run (\`${args.agent}\`, run \`${args.workflowId}\`).`,
    '',
    'This change passed the platform security gate. It was **not** tested or reviewed by a person; treat it as untrusted until you have.',
    args.stoppedReason
      ? `\nThe run stopped early (${args.stoppedReason === 'max_steps' ? 'step limit' : 'time limit'}); the work may be incomplete.`
      : '',
    args.findings > 0
      ? `\nThe static code scanner reported ${args.findings} advisory finding(s) on this diff.`
      : '',
    '',
    `### Files changed (${args.files.length})`,
    list,
    '',
    '### Agent summary',
    args.text
      ? `> ${neutraliseMentions(args.text.slice(0, 3000)).replace(/\n/g, '\n> ')}`
      : '_(no summary)_',
    '',
    '---',
    '_Generated by auto-swe. Humans merge._',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}
