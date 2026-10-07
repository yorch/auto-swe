/**
 * Step executors for `RunnableWorkflow`'s dispatcher.
 *
 * Steps are registered as executors in STEP_EXECUTORS, keyed by step name;
 * `dispatchStepImpl` does a single Map lookup with no `switch`. The map is
 * built once at module load — the `proxyActivities` stubs in
 * `runnableActivities.ts` are deterministic (no I/O), so this is safe inside
 * the V8 workflow isolate. Adding a step = adding a map entry; control flow
 * never changes.
 *
 * Each executor receives the same args; it derives `config.systemPrompt`
 * (toolsOverride is intentionally NOT passed to activities — tool selection is
 * DB-driven via AgentSkillAssignment, WORKFLOW_TEMPLATE → TEAM → GLOBAL).
 */

import type { WorkspaceProviderType } from '@auto-swe/shared/lib/workspaceProviders';
import type { CodeResult, RepoWorkRequest, Subtask } from '@auto-swe/shared/types/workflow';
import type { Context } from '@auto-swe/shared/workflow/expr';
import { workflowInfo } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import { buildLessonEvidence } from '../lib/lessonEvidence.js';
import { lookupPath } from '../lib/workflowEngine.js';
import {
  agentActivities,
  agentNodeActivities,
  agentTaskActivities,
  catalogActivities,
  ciConfigActivities,
  ciPollActivities,
  conflictActivities,
  containerStepActivities,
  contextActivities,
  evalNodeActivities,
  gateActivities,
  genericActivities,
  githubActivities,
  mcpNodeActivities,
  memoryActivities,
  mergeActivities,
  prdActivities,
  stateActivities,
} from './runnableActivities.js';

interface StepExecutorArgs {
  step: string;
  ctx: Context;
  request: RepoWorkRequest;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
}

type StepExecutor = (args: StepExecutorArgs) => Promise<unknown>;

/** Resolve a step's target connection, defaulting to the run-level workspace. */
function resolveConnectionId(step: string, ctx: Context, inputs: Record<string, unknown>): string {
  const workspaceConnectionId =
    ((ctx.context as Record<string, unknown>).workspace as Record<string, unknown> | undefined)
      ?.connectionId ?? undefined;
  const connectionId =
    (inputs.connectionId as string | undefined) ??
    (typeof workspaceConnectionId === 'string' ? workspaceConnectionId : undefined);
  if (!connectionId) {
    throw new Error(`${step} requires inputs.connectionId or a resolved workspace connection`);
  }
  return connectionId;
}

/**
 * Read the two cross-repo step opt-ins off a step's config (repo dependency
 * graph, P2) and hand them to the activity as a plain object.
 *
 * `crossRepoContext` defaults ON — it is a bounded prompt block, and an
 * unconfigured template should still get the graph. `crossRepoCheckout` defaults
 * OFF — it clones repos into the workspace. Only explicit booleans are passed
 * through, so `undefined` reaches the activity as "unset" and the activity's own
 * default applies.
 */
/** `config.allowedPaths` when it is a non-empty array of strings, else undefined. */
function allowedPathsConfig(config: Record<string, unknown>): string[] | undefined {
  const raw = config.allowedPaths;
  return Array.isArray(raw) && raw.length > 0 && raw.every((p) => typeof p === 'string')
    ? (raw as string[])
    : undefined;
}

function crossRepoOptions(config: Record<string, unknown>): {
  crossRepoCheckout?: boolean;
  crossRepoContext?: boolean;
} {
  return {
    ...(typeof config.crossRepoCheckout === 'boolean'
      ? { crossRepoCheckout: config.crossRepoCheckout }
      : {}),
    ...(typeof config.crossRepoContext === 'boolean'
      ? { crossRepoContext: config.crossRepoContext }
      : {}),
  };
}

// Shared executor for the six shell-bound quality gates — they differ only by
// the activity name, which is the step name itself.
const gateExecutor: StepExecutor = ({ step, ctx, request, config, inputs }) => {
  // Per-branch fan-out can override `branch` to point gates at the
  // subtask branch instead of the parent ticket branch (phase 8).
  const branchOverride =
    (inputs.branch as string | undefined) ??
    (config.branch as string | undefined) ??
    (lookupPath(ctx, 'context.currentCodeResult.branch') as string | undefined);
  const gateInput = {
    ...(branchOverride ? { branch: branchOverride } : {}),
    command: (inputs.command as string | undefined) ?? (config.command as string | undefined),
    request,
    timeoutMs: (inputs.timeoutMs as number | undefined) ?? (config.timeoutMs as number | undefined),
  };
  // All six gate activities share the same input/return shape; index by name.
  return gateActivities[step as 'runLint'](gateInput);
};

const STEP_EXECUTORS: ReadonlyMap<string, StepExecutor> = new Map<string, StepExecutor>([
  [
    'updateDomainState',
    async ({ config, inputs }) => {
      const status = (inputs.status ?? config.status) as string;
      await stateActivities.updateDomainState(workflowInfo().workflowId, status);
      return { status };
    },
  ],
  [
    'validateContext',
    ({ request, config }) =>
      contextActivities.validateContext(request, config.systemPrompt as string | undefined),
  ],
  [
    // P2 declarative agent node: run a library Agent by reference.
    'runAgentNode',
    ({ request, config, inputs }) =>
      agentNodeActivities.runAgentNode({
        agentRef: config.agentRef as string,
        // Phase A: thread the run's originating channel (if any) so the agent
        // resolves the CHANNEL config tier. Undefined for non-channel runs.
        ...(request.channelId ? { channelId: request.channelId } : {}),
        inputs,
        spanName: config.spanName as string | undefined,
        // Phase C: soft steering drained by the interpreter from the `steer`
        // signal buffer; the activity prepends it as a labeled prompt block.
        ...(config.steering ? { steering: config.steering as string[] } : {}),
        systemPrompt: config.systemPrompt as string | undefined,
        userMessage: config.userMessage as string | undefined,
      }),
  ],
  [
    // Internal step of the Agent Run system template. The activity re-checks that
    // it is running for that template; nothing here is trusted to have been checked.
    'runAgentTask',
    ({ request }) => agentTaskActivities.runAgentTask({ request }),
  ],
  [
    // Evals P2 declarative eval node: score a target value with a list of scorers.
    'runEvalNode',
    ({ config }) =>
      evalNodeActivities.runEvalNode({
        judgeAdvisory: config.judgeAdvisory as boolean | undefined,
        scorers: config.scorers as Parameters<typeof evalNodeActivities.runEvalNode>[0]['scorers'],
        spanName: config.spanName as string | undefined,
        targetValue: config.targetValue,
      }),
  ],
  [
    // P2/WS4 declarative mcp node: call one MCP tool as a workflow step.
    'mcpCallTool',
    ({ config, inputs }) =>
      mcpNodeActivities.mcpCallTool({
        connectionRef: config.connectionRef as string,
        inputs,
        spanName: config.spanName as string | undefined,
        tool: config.tool as string,
      }),
  ],
  [
    // P4/WS4 container-contract coded step: run an image with JSON in/out.
    'runContainerStep',
    ({ request, config, inputs }) =>
      containerStepActivities.runContainerStep({
        command: config.command as string | undefined,
        cpus: config.cpus as number | undefined,
        image: config.image as string,
        inputs,
        memory: config.memory as string | undefined,
        network: config.network as 'none' | 'egress' | undefined,
        request,
        ...(config.sidecar
          ? { sidecar: config.sidecar as { port: number; requestPath?: string } }
          : {}),
        timeoutMs: config.timeoutMs as number | undefined,
        transport: config.transport as 'stdout' | 'ndjson' | 'sidecar' | undefined,
      }),
  ],
  [
    'executeImplementation',
    ({ ctx, request, config, inputs }) => {
      const systemPromptOverride = config.systemPrompt as string | undefined;
      const crossRepo = crossRepoOptions(config);
      // Inside a fanOut, the per-branch element is bound at `ctx[itemKey]`; the
      // interpreter names that key at `fanOut.itemKey` (default `subtask`).
      const itemKey = (lookupPath(ctx, 'fanOut.itemKey') as string | undefined) ?? 'subtask';
      const subtask =
        (inputs.subtask as Subtask | undefined) ??
        (lookupPath(ctx, itemKey) as Subtask | undefined);
      // `subtask` is already `Subtask | undefined`, so both arms of the ternary
      // this replaced passed the same thing.
      const guidance = formatGuidance(inputs.guidance);
      const effectiveRequest = guidance
        ? {
            ...request,
            description: `${request.description}\n\n## Guidance from the requester\n${guidance}`,
          }
        : request;
      const allowedPaths = allowedPathsConfig(config);
      // The fifth argument is passed only when set, so a step that does not set it
      // calls the activity exactly as before.
      return allowedPaths
        ? agentActivities.executeImplementation(
            effectiveRequest,
            subtask,
            systemPromptOverride,
            crossRepo,
            allowedPaths
          )
        : agentActivities.executeImplementation(
            effectiveRequest,
            subtask,
            systemPromptOverride,
            crossRepo
          );
    },
  ],
  [
    'runReviewNetwork',
    ({ ctx, config, inputs }) => {
      const codeResult = pickCodeResult(inputs.codeResult, ctx);
      const successCriteria =
        (inputs.successCriteria as string[] | undefined) ??
        (lookupPath(ctx, 'context.successCriteria') as string[] | undefined);
      return agentActivities.runReviewNetwork(
        codeResult,
        successCriteria,
        config.systemPrompt as string | undefined,
        crossRepoOptions(config)
      );
    },
  ],
  [
    'executeReviewFixImplementation',
    ({ ctx, config, inputs }) => {
      const rejection =
        (inputs.rejectionSummary as string | undefined) ??
        (lookupPath(ctx, 'context.lastRejectionSummary') as string | undefined) ??
        '';
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      const allowedPaths = allowedPathsConfig(config);
      return allowedPaths
        ? agentActivities.executeReviewFixImplementation(
            rejection,
            prev,
            config.systemPrompt as string | undefined,
            allowedPaths
          )
        : agentActivities.executeReviewFixImplementation(
            rejection,
            prev,
            config.systemPrompt as string | undefined
          );
    },
  ],
  [
    'executeCIFixImplementation',
    ({ ctx, config, inputs }) => {
      const failureContext =
        (inputs.failureContext as string | undefined) ??
        (lookupPath(ctx, 'context.lastCILogs') as string | undefined) ??
        '';
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      return agentActivities.executeCIFixImplementation(
        failureContext,
        prev,
        config.systemPrompt as string | undefined
      );
    },
  ],
  [
    'createOrUpdatePullRequest',
    ({ ctx, request, config, inputs }) => {
      const codeResult = pickCodeResult(inputs.codeResult, ctx);
      // Passed only when set, so every existing template calls the activity exactly as before.
      return config.draft === true
        ? githubActivities.createOrUpdatePullRequest(request, codeResult, { draft: true })
        : githubActivities.createOrUpdatePullRequest(request, codeResult);
    },
  ],
  ['listProviderModels', ({ request }) => catalogActivities.listProviderModels({ request })],
  [
    'fetchCILogs',
    ({ request, inputs }) =>
      githubActivities.fetchCILogs(
        inputs.logsUrl as string | undefined,
        request.repoId ?? undefined
      ),
  ],
  ['resolveCiWaitConfig', () => ciConfigActivities.resolveCiWaitConfig()],
  [
    'waitForCiByPolling',
    ({ ctx, request, inputs }) => {
      const ref =
        (inputs.ref as string | undefined) ??
        (lookupPath(ctx, 'context.currentCodeResult.branch') as string | undefined);
      if (!ref) {
        throw new Error(
          'waitForCiByPolling requires inputs.ref or context.currentCodeResult.branch'
        );
      }
      return ciPollActivities.waitForCiByPolling({
        deadlineSec: inputs.deadlineSec as number,
        graceSec: inputs.graceSec as number,
        intervalSec: inputs.intervalSec as number,
        ref,
        repoId: request.repoId,
      });
    },
  ],
  [
    'commitToMemory',
    async ({ ctx, request, config, inputs }) => {
      const repoId = (inputs.repoId as string | undefined) ?? request.repoId;
      // What the run recorded, so the lesson rests on it rather than on the
      // ticket alone. Read from context here: the loops already keep it there.
      const evidence = buildLessonEvidence({
        ciLogs: lookupPath(ctx, 'context.lastCILogs'),
        codeResult: lookupPath(ctx, 'context.currentCodeResult'),
        outcome: inputs.outcome,
        rejectionSummary: lookupPath(ctx, 'context.lastRejectionSummary'),
      });
      const lessonId = await memoryActivities.commitToMemory(
        workflowInfo().workflowId,
        repoId,
        config.systemPrompt as string | undefined,
        evidence
      );
      return { lessonId };
    },
  ],
  // ── Phase 2 quality gates (all six share gateExecutor) ──────────────────────
  ['runLint', gateExecutor],
  ['runTypecheck', gateExecutor],
  ['runTests', gateExecutor],
  ['runBuild', gateExecutor],
  ['runVulnScan', gateExecutor],
  ['runPerfBench', gateExecutor],
  [
    'planDecomposition',
    ({ request, config }) =>
      agentActivities.planDecomposition(request, config.systemPrompt as string | undefined),
  ],
  [
    // General-route decomposition planner. `task` binds from request.description;
    // thread the run's channelId so the planner resolves the CHANNEL model tier.
    'planChannelTask',
    ({ request, config, inputs }) =>
      agentNodeActivities.planChannelTask({
        task: (inputs.task as string | undefined) ?? request.description,
        ...(request.channelId ? { channelId: request.channelId } : {}),
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt as string } : {}),
      }),
  ],
  [
    // Decompose path: run each planned subtask + synthesize (long-running, so it
    // rides the agent proxy). `subtasks` binds from the planner's output.
    'runChannelSubtasks',
    ({ request, config, inputs }) =>
      agentActivities.runChannelSubtasks({
        subtasks: (inputs.subtasks as { title: string; description: string }[] | undefined) ?? [],
        task: (inputs.task as string | undefined) ?? request.description,
        ...(request.channelId ? { channelId: request.channelId } : {}),
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt as string } : {}),
      }),
  ],
  [
    'mergeBranches',
    ({ step, request, config, inputs }) => {
      const { targetBranch, sourceBranches } = resolveMergeBindings(step, request, config, inputs);
      return mergeActivities.mergeBranches({
        ...(config.mergeMessagePrefix
          ? { mergeMessagePrefix: config.mergeMessagePrefix as string }
          : {}),
        request,
        sourceBranches,
        targetBranch,
      });
    },
  ],
  [
    'resolveMergeConflict',
    ({ step, request, config, inputs }) => {
      // Decision 17 symmetry: sourceBranches must be bound explicitly
      // (typically `{ from: 'nodes.merge.output.unmergedBranches' }`).
      const { targetBranch, sourceBranches } = resolveMergeBindings(step, request, config, inputs);
      const maxAttemptsPerBranch =
        (inputs.maxAttemptsPerBranch as number | undefined) ??
        (config.maxAttemptsPerBranch as number | undefined);
      return conflictActivities.resolveMergeConflict({
        ...(config.mergeMessagePrefix
          ? { mergeMessagePrefix: config.mergeMessagePrefix as string }
          : {}),
        ...(typeof maxAttemptsPerBranch === 'number' ? { maxAttemptsPerBranch } : {}),
        request,
        sourceBranches,
        targetBranch,
      });
    },
  ],
  // ── PRD decomposition workflow ───────────────────────────────────────────────
  [
    'analyzePrd',
    ({ request, config }) =>
      prdActivities.analyzePrd(request, config.systemPrompt as string | undefined),
  ],
  [
    'decomposePrd',
    ({ request, config, inputs }) =>
      prdActivities.decomposePrd(
        request,
        { analysis: inputs.analysis, pmFeedback: inputs.pmFeedback },
        config.systemPrompt as string | undefined
      ),
  ],
  [
    'createTrackerItems',
    ({ request, inputs }) =>
      prdActivities.createTrackerItems(request, {
        decomposition: inputs.decomposition,
      }),
  ],
  [
    'submitPrdWorkRequests',
    ({ request, inputs }) =>
      prdActivities.submitPrdWorkRequests(request, {
        decomposition: inputs.decomposition,
        trackerItems: inputs.trackerItems,
      }),
  ],
  [
    'executeGateFixImplementation',
    ({ ctx, config, inputs }) => {
      const gateName =
        (inputs.gateName as string | undefined) ??
        (config.gateName as string | undefined) ??
        'unknown';
      const gateOutput = (inputs.gateOutput ?? lookupPath(ctx, 'context.lastGateOutput')) as
        | activitiesType.GateResult
        | undefined;
      if (!gateOutput) {
        throw new Error(
          'executeGateFixImplementation requires inputs.gateOutput or context.lastGateOutput'
        );
      }
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      return agentActivities.executeGateFixImplementation({
        gateName,
        gateOutput,
        previousCodeResult: prev,
        systemPromptOverride: config.systemPrompt as string | undefined,
      });
    },
  ],
  [
    'resolveWorkspace',
    async ({ request, config, inputs, ctx }) => {
      const workspaceCtx =
        ((ctx.context as Record<string, unknown>).workspace as
          | Record<string, unknown>
          | undefined) ?? {};
      const workspaceProvider =
        (config.workspaceProvider as WorkspaceProviderType | undefined) ??
        (workspaceCtx.provider as WorkspaceProviderType | undefined) ??
        'git_repo';
      const connectionId =
        (inputs.connectionId as string | null | undefined) ??
        (workspaceCtx.connectionId as string | null | undefined) ??
        request.connectionId ??
        null;
      const result = await genericActivities.resolveWorkspace({
        connectionId,
        payload: (inputs.payload as unknown) ?? request.payload,
        workspaceProvider,
      });
      (ctx.context as Record<string, unknown>).workspace = { ...workspaceCtx, ...result };
      return result;
    },
  ],
  [
    'readSource',
    ({ inputs, ctx, step }) =>
      genericActivities.readSource({
        connectionId: resolveConnectionId(step, ctx, inputs),
        query:
          inputs.pageId !== undefined
            ? { pageId: inputs.pageId as string }
            : inputs.ticketId !== undefined
              ? { ticketId: inputs.ticketId as string }
              : inputs.query,
      }),
  ],
  [
    'writeOutcome',
    ({ inputs, ctx, step }) => {
      let data = inputs.data;
      // Convenience for Notion: a template can pass `text` + `pageId` and the
      // step wraps it into a single paragraph block.
      if (data === undefined && inputs.text && inputs.pageId) {
        data = {
          blocks: [
            {
              paragraph: {
                rich_text: [{ text: { content: inputs.text as string } }],
              },
              type: 'paragraph',
            },
          ],
          pageId: inputs.pageId,
        };
      }
      // Convenience for Zendesk: build a comment payload from `body`, `ticketId`,
      // and the optional `public` flag.
      if (
        data === undefined &&
        typeof inputs.body === 'string' &&
        typeof inputs.ticketId === 'string'
      ) {
        data = {
          body: inputs.body,
          public: inputs.public === true,
          ticketId: inputs.ticketId,
        };
      }
      // Convenience for Zendesk: pass through the public/private flag.
      if (typeof inputs.public === 'boolean' && typeof data === 'object' && data != null) {
        data = { ...(data as object), public: inputs.public };
      }
      return genericActivities.writeOutcome({
        connectionId: resolveConnectionId(step, ctx, inputs),
        data,
        nodeId: step,
      });
    },
  ],
  [
    'publishOutcome',
    ({ config, ctx, inputs }) =>
      genericActivities.publishOutcome({
        action:
          (inputs.action as string | undefined) ??
          (config.action as string | undefined) ??
          'external_communication',
        description: inputs.description as string | undefined,
        workflowId: (ctx.workflow as { id: string }).id,
      }),
  ],
  [
    'runTool',
    ({ inputs, ctx, step }) =>
      genericActivities.runTool({
        connectionId: resolveConnectionId(step, ctx, inputs),
        inputs: inputs.inputs,
        tool: inputs.tool as string,
      }),
  ],
]);

export async function dispatchStepImpl(
  step: string,
  ctx: Context,
  request: RepoWorkRequest,
  config: Record<string, unknown>,
  inputs: Record<string, unknown>
): Promise<unknown> {
  const executor = STEP_EXECUTORS.get(step);
  if (!executor) {
    throw new Error(`unknown step: ${step}`);
  }
  return executor({ config, ctx, inputs, request, step });
}

// ── Helpers ──

/**
 * Render a human-supplied `guidance` input (free text, or the field map a
 * `humanInput` node stores) as prompt text. Blank fields are dropped so an
 * unanswered form contributes nothing.
 */
function formatGuidance(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (typeof raw !== 'object' || raw === null) {
    return '';
  }
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
    .map(([k, v]) => `- ${k}: ${(v as string).trim()}`)
    .join('\n');
}

function pickCodeResult(provided: unknown, ctx: Context): CodeResult {
  const v = provided ?? lookupPath(ctx, 'context.currentCodeResult');
  if (!v) {
    throw new Error('step requires a CodeResult but none is bound (context.currentCodeResult)');
  }
  return v as CodeResult;
}

/**
 * Resolve the shared `targetBranch` + `sourceBranches` bindings used by
 * `mergeBranches` and `resolveMergeConflict`. Both require `sourceBranches`
 * to be an explicit `string[]` input binding (decision 17).
 */
function resolveMergeBindings(
  step: string,
  request: RepoWorkRequest,
  config: Record<string, unknown>,
  inputs: Record<string, unknown>
): { targetBranch: string; sourceBranches: string[] } {
  const branchPrefix = (config.branchPrefix as string | undefined) ?? 'auto';
  const targetBranch =
    (inputs.targetBranch as string | undefined) ??
    (config.targetBranch as string | undefined) ??
    `${branchPrefix}/${request.externalTicketId}`;
  const raw = inputs.sourceBranches;
  if (!Array.isArray(raw) || raw.some((b) => typeof b !== 'string')) {
    throw new Error(`${step}: inputs.sourceBranches must be a string[]`);
  }
  return { sourceBranches: raw as string[], targetBranch };
}
