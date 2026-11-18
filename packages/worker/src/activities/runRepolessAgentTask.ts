import { AGENT_RUN_MAX_TEXT_CHARS } from '@auto-swe/shared/lib/agentRun';
import { ApplicationFailure } from '@temporalio/activity';
import { grantsBrowserTool } from '../agents/agentRunTools.js';
import { BrowserToolset, createMastraBrowserTools } from '../agents/browserTools.js';
import { buildKnowledgeTools } from '../agents/knowledgeTools.js';
import { loadMcpTools } from '../agents/mcpTools.js';
import { persistActivityTrace, startTraceFlushing } from '../lib/activityContext.js';
import { AgentTracer, redactString } from '../lib/agentTracer.js';
import { boundToolKeys } from '../lib/boundToolKeys.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { resolveAgentRuntime } from '../lib/config/agentRuntime.js';
import { type AgentTools, resolveAgentSpec } from '../lib/config/agentSpec.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import type { ModelBackedAgentKey, ResolveCtx } from '../lib/config/types.js';
import { throwIfActivityCancelled } from '../lib/execUtils.js';
import { withMcpApproval } from '../lib/mcpApproval.js';
import { createSteeringPrepareStep } from '../lib/runSteering.js';
import {
  createScratchBrowserWorkspace,
  type ScratchBrowserWorkspace,
} from '../lib/scratchBrowserWorkspace.js';
import { assertModelPricedForUsdCap } from '../lib/usdCapGuard.js';
import { runAgent } from './runAgent.js';
import type { RunAgentTaskResult } from './runAgentTask.js';

/**
 * The repo-less agent run: a READER child of a repo-less orchestration. It has no repository, no
 * workspace, no clone, no push policy, no gate and no delivery — its tools are exactly what the
 * agent's own definition grants of MCP, knowledge search and the browser.
 * No workspace tool is ever bound, whatever `toolKeys` says.
 *
 * The one container a repo-less run may have is a throwaway one for the browser, made only when
 * the agent grants `browser` and only when restricted egress can be enforced
 * (`lib/scratchBrowserWorkspace.ts`); it holds no repository and no credential, binds no workspace
 * tool, and is removed in the `finally` below. Where it cannot be made the child runs without a
 * browser and records why.
 *
 * The caller (`runAgentTask`) has already proved this is the Agent Run template, that the ledger
 * row names no repository, that the run is a confirmed orchestration child that delivers nothing,
 * and has taken the admission decision. This function trusts none of that beyond what it is given
 * and adds the checks only it can make: the loop must be Mastra (the harness runtimes need a
 * container) and the agent's MCP connection must belong to the team the run is billed to.
 */

const REPOLESS_PREAMBLE = [
  'You have no repository and no workspace: there are no files to read or write.',
  'Use only the tools you were given. Answer with your findings as your final message; it is returned to the orchestrator as your one result.',
].join('\n');

const BROWSER_PREAMBLE =
  'You have a browser. Its network access is restricted to an allowlist of hosts; a page outside it will not load.';

/** Never throws: any failure is a reason the child runs without a browser. */
async function createBrowserScratch(teamId: string | null) {
  try {
    return await createScratchBrowserWorkspace({ teamId });
  } catch (error) {
    return {
      ok: false as const,
      reason: `the scratch container could not be started: ${redactString(
        error instanceof Error ? error.message : String(error)
      ).slice(0, 300)}`,
    };
  }
}

export interface RepolessAgentInput {
  /** The launch ref (`key` or `key@version`), echoed in the result. */
  agentRef: string;
  key: string;
  version?: number;
  /** The tenant the run is billed to: `teamId` and `orgId` come from the work request, not a repository. */
  baseCtx: ResolveCtx;
  effective: { maxSteps: number; maxWallClockSeconds: number };
  prompt: string;
  /**
   * The run's `WorkflowRun.id`: its undelivered steering messages are drained at step boundaries and
   * its MCP calls go through the orchestration approval guard. A repo-less run is always an
   * orchestration child, so it is required.
   */
  runId: string;
}

export async function runRepolessAgent(input: RepolessAgentInput): Promise<RunAgentTaskResult> {
  const { key, version, baseCtx, effective, prompt } = input;
  const settingsCtx: ResolveCtx = { orgId: baseCtx.orgId, teamId: baseCtx.teamId };
  const agentCtx: ResolveCtx = {
    agentVersions: {
      ...(baseCtx.agentVersions ?? {}),
      ...(version !== undefined ? { [key]: version } : {}),
    },
    orgId: baseCtx.orgId,
    skillRevisions: baseCtx.skillRevisions,
  };
  const resolved = await resolveAgent(key, agentCtx);
  await assertModelPricedForUsdCap(resolved.model.spec);
  const loop = await resolveAgentRuntime(key, agentCtx, 'agentRunSetting', {
    ...settingsCtx,
    pinnedSettings: baseCtx.pinnedSettings,
  });
  if (loop.runtime !== 'mastra') {
    // Before any work: a harness loop runs in a container, and this run has none.
    throw ApplicationFailure.nonRetryable(
      `Agent '${key}' runs on the ${loop.runtime} loop, which needs a workspace; a run with no repository cannot use it`,
      'AGENT_RUN_NEEDS_WORKSPACE'
    );
  }

  const tracer = new AgentTracer();
  const closeFns: Array<() => Promise<void>> = [];
  let browserToolset: BrowserToolset | undefined;
  let scratch: ScratchBrowserWorkspace | undefined;
  const stopTraceFlushing = startTraceFlushing(tracer, resolved.key);
  try {
    tracer.addActivityEvent({
      name: 'agent.runtime',
      outputJson: { agentKey: key, runtime: loop.runtime, source: loop.source, workspace: false },
    });
    let browserTools: ReturnType<typeof createMastraBrowserTools> | undefined;
    if (grantsBrowserTool(resolved.toolKeys)) {
      // The browser runs in a container. A repo-less run has no workspace, so it gets a throwaway
      // one that holds only a browser, behind restricted egress; refused (and the child carries on
      // without a browser) wherever that cannot be enforced. Created before the loop starts so a
      // missing browser image or proxy is known up front, and the finally below removes it.
      const created = await createBrowserScratch(settingsCtx.teamId ?? null);
      if (created.ok) {
        scratch = created.workspace;
        browserToolset = new BrowserToolset({
          allowedHosts: created.allowedHosts,
          containerId: created.workspace.containerId,
          repoId: null,
          tracer,
          workspace: created.workspace,
        });
        browserTools = createMastraBrowserTools(browserToolset);
        tracer.addActivityEvent({
          name: 'agent.browser_egress',
          outputJson: {
            agentKey: key,
            allowedHostCount: created.allowedHostCount,
            egressPolicy: 'restricted',
          },
        });
      } else {
        tracer.addActivityEvent({
          name: 'agent.browser_unavailable',
          outputJson: { agentKey: key, reason: created.reason },
        });
      }
    }

    const grantsSearch = resolved.toolKeys?.includes('searchKnowledge') === true;
    const knowledgeTools = grantsSearch
      ? buildKnowledgeTools(tracer, { includeGoverned: true, snapshotIds: [] })
      : undefined;
    const spec = await resolveAgentSpec(
      {
        agentKey: key as ModelBackedAgentKey,
        // Offered tools are intersected with the agent's `toolKeys`; no workspace tool is offered.
        availableTools: (knowledgeTools
          ? { searchKnowledge: knowledgeTools.searchKnowledge }
          : {}) as unknown as AgentTools,
        basePrompt: '',
      },
      agentCtx
    );
    // `toolKeys` names the grant (`browser`), not the tool ids, so the intersection above dropped
    // them; the grant was checked by `grantsBrowserTool` and the toolset exists only if it held.
    if (browserTools) {
      spec.tools = { ...browserTools, ...spec.tools } as AgentTools;
    }
    spec.systemPrompt =
      `${spec.systemPrompt}\n\n${REPOLESS_PREAMBLE}${browserTools ? `\n${BROWSER_PREAMBLE}` : ''}`.trim();

    // MCP per the agent's own configuration, checked against the team the run is billed to (the
    // repository path checks the repository's team).
    // Every call goes through the orchestration's approval guard (the connection must be in the
    // fixed set, a write waits for the launcher, a service principal's writes are denied) and its
    // results are screened, exactly as on the repository path.
    const deadline = AbortSignal.timeout(Math.max(1000, effective.maxWallClockSeconds * 1000));
    const mcpTarget = await withMcpApproval(
      await resolveAgentMcpUrl(key, agentCtx, { tenant: settingsCtx, tracer }),
      { expectOrchestrated: true, runId: input.runId, signal: deadline, tracer }
    );
    let mcpTools: AgentTools | undefined;
    if (mcpTarget) {
      const loaded = await loadMcpTools(mcpTarget, tracer);
      closeFns.push(loaded.close);
      mcpTools = loaded.tools as AgentTools;
      spec.tools = { ...loaded.tools, ...spec.tools } as AgentTools;
    }

    throwIfActivityCancelled();
    const result = await runAgent(spec, prompt, {
      abortSignal: deadline,
      ctx: settingsCtx,
      maxSteps: effective.maxSteps,
      perStepAccounting: true,
      prepareStep: createSteeringPrepareStep(input.runId, tracer),
      selfRecordingTools: boundToolKeys(spec.tools, mcpTools, knowledgeTools, browserTools),
      spanName: 'llm.agent_run',
      tracer,
    });
    return {
      agent: input.agentRef,
      baseSha: '',
      codeSecurityFindingCount: 0,
      costUsd: result.costUsd,
      deliver: 'none',
      diff: '',
      diffTruncated: false,
      diffVerified: false,
      effective,
      filesChanged: [],
      gate: 'not_applicable',
      steps: result.stepCount,
      ...(result.stoppedReason ? { stoppedReason: result.stoppedReason } : {}),
      text: redactString(result.text ?? '').slice(0, AGENT_RUN_MAX_TEXT_CHARS),
    };
  } finally {
    stopTraceFlushing();
    await Promise.allSettled(closeFns.map((close) => close()));
    // The toolset first: closing it reads the recording and trace out of the container. Then the
    // container goes, whatever happened above (an abort, the deadline, a cancel, a model error).
    await browserToolset?.close().catch(() => {});
    await scratch?.destroy().catch(() => {});
    await persistActivityTrace(tracer, resolved.key);
  }
}
