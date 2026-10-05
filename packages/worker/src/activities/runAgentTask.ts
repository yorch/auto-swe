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
import { clampPullRequestTitle } from '@auto-swe/shared/lib/pullRequest';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { FileChange, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';
import { selectAgentRunTools } from '../agents/agentRunTools.js';
import { loadMcpTools } from '../agents/mcpTools.js';
import { buildWorkspaceTools } from '../agents/workspaceTools.js';
import { currentWorkflowId, persistActivityTrace } from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import { loadLiveAgentRunSlots } from '../lib/agentRunSlots.js';
import { AgentTracer, redactString } from '../lib/agentTracer.js';
import { boundToolKeys } from '../lib/boundToolKeys.js';
import { parseAgentRef } from '../lib/config/agentRef.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { type AgentTools, resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import type { ModelBackedAgentKey, ResolveCtx } from '../lib/config/types.js';
import { throwIfActivityCancelled, withHeartbeat } from '../lib/execUtils.js';
import { requireRepoId } from '../lib/requireRepoId.js';
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
    select: { id: true, repoId: true },
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

  // ── 4. Resolve the agent: GLOBAL and ORGANIZATION scope only. A member of a
  // team the repo is shared with launches this, so the owning team's own agent
  // overrides, and the template's, must not apply.
  const agentCtx: ResolveCtx = {
    agentVersions: {
      ...(baseCtx.agentVersions ?? {}),
      ...(version !== undefined ? { [key]: version } : {}),
    },
    orgId: baseCtx.orgId,
    // Same reason as agentVersions: the run's skill text is frozen at its start.
    skillRevisions: baseCtx.skillRevisions,
  };
  const resolved = await resolveAgent(key, agentCtx);
  // Before any container exists: an unpriced model under a USD cap is refused
  // here rather than after a clone (runAgent checks again before the call).
  await assertModelPricedForUsdCap(resolved.model.spec);

  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { host: true, installationId: true } } },
    where: { id: repoId },
  });
  const workflowDefaults = await resolveWorkflowDefaults();
  const branch = `${workflowDefaults.branchPrefix}/${request.externalTicketId}`;
  const repoRef = toRepoRef(repo);
  const scm = getScmProvider(repoRef);
  const { authedCloneUrl } = await scm.cloneCredentials(repoRef);

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
      repo.defaultBranch,
      repo.executorImage ?? undefined
    );
    const baseSha = (await agentWs.exec('git rev-parse HEAD')).trim();

    // ── 5. Tools: read tools unless a write tool is NAMED in the agent's toolKeys.
    const built = buildWorkspaceTools(agentWs, tracer, settings['workspace.maxToolOutputChars']);
    const spec = await resolveAgentSpec(
      {
        agentKey: key as ModelBackedAgentKey,
        availableTools: selectAgentRunTools(built, resolved.toolKeys) as unknown as AgentTools,
        basePrompt: '',
      },
      agentCtx
    );
    spec.systemPrompt = `${spec.systemPrompt}\n\n${WORKSPACE_PREAMBLE}`.trim();

    // MCP per the agent's own configuration (a known exfiltration channel next
    // to a workspace; documented in docs/agent-runs.md).
    const mcpTarget = await resolveAgentMcpUrl(key, agentCtx);
    let mcpTools: AgentTools | undefined;
    if (mcpTarget) {
      const loaded = await loadMcpTools(mcpTarget.url, tracer, {
        bearerToken: mcpTarget.bearerToken,
        callTimeoutMs: mcpTarget.callTimeoutMs,
        listTimeoutMs: mcpTarget.listTimeoutMs,
      });
      closeMcp = loaded.close;
      mcpTools = loaded.tools as AgentTools;
      spec.tools = { ...loaded.tools, ...spec.tools } as AgentTools;
    }

    // ── 6. Run the agent, bounded, with every step debited as it lands.
    throwIfActivityCancelled();
    const result = await runAgent(spec, request.description, {
      abortSignal: AbortSignal.timeout(effective.maxWallClockSeconds * 1000),
      ctx: settingsCtx,
      maxSteps: effective.maxSteps,
      perStepAccounting: true,
      // The workspace and MCP tools record their own calls on this tracer; any
      // other tool's calls are recorded from the loop's steps.
      selfRecordingTools: boundToolKeys(spec.tools, built, mcpTools),
      spanName: 'llm.agent_run',
      tracer,
    });
    const text = redactString(result.text ?? '').slice(0, AGENT_RUN_MAX_TEXT_CHARS);
    const base: Omit<
      RunAgentTaskResult,
      | 'diff'
      | 'diffTruncated'
      | 'diffVerified'
      | 'filesChanged'
      | 'gate'
      | 'codeSecurityFindingCount'
    > = {
      agent: payload.agentRef,
      baseSha,
      costUsd: result.costUsd,
      deliver: payload.deliver,
      effective,
      steps: result.stepCount,
      stoppedReason: result.stoppedReason,
      text,
    };

    // ── 7a. Nothing leaves the sandbox: show the agent's own view, unverified.
    if (payload.deliver === 'none') {
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

    // ── 7b. Delivery: judge and publish from a FRESH container the agent never ran in.
    throwIfActivityCancelled();
    trusted = await createWorkspace(
      authedCloneUrl,
      branch,
      repo.defaultBranch,
      repo.executorImage ?? undefined,
      baseSha
    );
    await importAgentTree(agentWs, trusted);
    const committed = await commitTrustedTree(
      trusted,
      baseSha,
      `auto: agent run ${request.externalTicketId} (${payload.agentRef})`
    );
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
      allowWorkflowChanges: settings['workspace.agentRunAllowWorkflowChanges'],
      baseSha,
      sha: committed.sha,
      tracer,
    });
    await pushGatedCommit(trusted, gated, branch);
    tracer.addActivityEvent({
      name: 'git.commit_push',
      outputJson: { branch, headSha: gated.sha },
    });

    let pr: { prNumber: number; prUrl: string } | undefined;
    if (payload.deliver === 'draft_pr') {
      const title = prTitle(request.description);
      try {
        pr = await scm.createOrUpdatePullRequest({
          baseBranch: repo.defaultBranch,
          body: prBody({
            agent: payload.agentRef,
            files: gated.filesChanged,
            findings: gated.codeSecurityFindings.length,
            stoppedReason: result.stoppedReason,
            text,
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
            ? `This repository does not support draft pull requests. The branch ${branch} was pushed (${gated.sha}); open a pull request from it manually or re-run with deliver=branch.`
            : `The branch ${branch} was pushed (${gated.sha}) but the pull request could not be opened: ${err instanceof Error ? err.message : String(err)}`,
          unsupported ? 'DRAFT_PR_UNSUPPORTED' : 'PR_CREATE_FAILED',
          { branch, headSha: gated.sha }
        );
      }
      await recordAgentRunPullRequest(
        {
          headSha: gated.sha,
          isDraft: true,
          ledgerId: ledger.id,
          prNumber: pr.prNumber,
          repoId,
          title,
        },
        tracer
      );
    }

    return {
      ...base,
      branch,
      codeSecurityFindingCount: gated.codeSecurityFindings.length,
      headSha: gated.sha,
      ...capDiff(gated.diff),
      diffVerified: true,
      filesChanged: capFilesChanged(gated.filesChanged),
      gate: 'passed',
      ...(pr ? { prNumber: pr.prNumber, prUrl: pr.prUrl } : {}),
    };
  } finally {
    await closeMcp?.();
    await persistActivityTrace(tracer, resolved.key);
    // The agent workspace never holds the push credential, but both are removed.
    await agentWs?.destroy();
    await trusted?.destroy();
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
    title: string;
  },
  tracer: AgentTracer
): Promise<void> {
  try {
    await prisma.pullRequest.create({
      data: {
        ciStatus: 'PENDING',
        headSha: args.headSha,
        isDraft: args.isDraft,
        prNumber: args.prNumber,
        repoId: args.repoId,
        status: 'OPEN',
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
