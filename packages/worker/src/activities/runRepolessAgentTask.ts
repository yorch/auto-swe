import { AGENT_RUN_MAX_TEXT_CHARS } from '@auto-swe/shared/lib/agentRun';
import { ApplicationFailure } from '@temporalio/activity';
import { grantsBrowserTool } from '../agents/agentRunTools.js';
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
import { assertModelPricedForUsdCap } from '../lib/usdCapGuard.js';
import { runAgent } from './runAgent.js';
import type { RunAgentTaskResult } from './runAgentTask.js';

/**
 * The repo-less agent run: a READER child of a repo-less orchestration. It has no repository, no
 * container, no clone, no push policy, no gate and no delivery — its tools are exactly what the
 * agent's own definition grants of MCP, knowledge search and (not available here) the browser.
 * No workspace tool is ever bound, whatever `toolKeys` says.
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
  const stopTraceFlushing = startTraceFlushing(tracer, resolved.key);
  try {
    tracer.addActivityEvent({
      name: 'agent.runtime',
      outputJson: { agentKey: key, runtime: loop.runtime, source: loop.source, workspace: false },
    });
    if (grantsBrowserTool(resolved.toolKeys)) {
      // The browser runs inside a workspace container; there is none here.
      tracer.addActivityEvent({
        name: 'agent.browser_unavailable',
        outputJson: { agentKey: key, reason: 'a run with no repository has no workspace' },
      });
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
    spec.systemPrompt = `${spec.systemPrompt}\n\n${REPOLESS_PREAMBLE}`.trim();

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
      selfRecordingTools: boundToolKeys(spec.tools, mcpTools, knowledgeTools),
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
    await persistActivityTrace(tracer, resolved.key);
  }
}
