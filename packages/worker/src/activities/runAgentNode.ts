import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { grantedWorkspaceToolIds, selectAgentRunTools } from '../agents/agentRunTools.js';
import { HARNESSES } from '../agents/harnessRegistry.js';
import { runImplementerTurn } from '../agents/implementerRuntime.js';
import { loadMcpTools } from '../agents/mcpTools.js';
import { buildWorkspaceTools } from '../agents/workspaceTools.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { boundToolKeys } from '../lib/boundToolKeys.js';
import { parseAgentRef } from '../lib/config/agentRef.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { type ResolvedAgentRuntime, resolveAgentRuntime } from '../lib/config/agentRuntime.js';
import type { AgentTools } from '../lib/config/agentSpec.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { withChannelScope } from '../lib/config/channelContext.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import type { ModelBackedAgentKey, ResolveCtx } from '../lib/config/types.js';
import { assertBudgetAvailable } from '../lib/costTracking.js';
import { throwIfActivityCancelled, withHeartbeat } from '../lib/execUtils.js';
import { resolveRunBaseBranch } from '../lib/runBaseBranch.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { assertModelPricedForUsdCap } from '../lib/usdCapGuard.js';
import { runAgent } from './runAgent.js';
import { createWorkspace, fetchBranchesSubcommand, shellQuote } from './workspace.js';

export interface RunAgentNodeInput {
  /** Library agent reference: `<key>` (float) or `<key>@<version>` (pin). */
  agentRef: string;
  /** Literal user message; when omitted, the resolved node inputs become the message (see {@link inputsToMessage}). */
  userMessage?: string;
  /** Resolved node inputs (used as the message payload when userMessage is absent). */
  inputs?: Record<string, unknown>;
  /** OTel span + cost-attribution name. */
  spanName?: string;
  /** Per-node system-prompt override (wins over the Agent's own prompt). */
  systemPrompt?: string;
  /**
   * Channel assistant (Phase A): SlackChannel.id the run originated from. When
   * set, the agent resolves the CHANNEL config tier (per-channel tools/MCP/model)
   * — `currentRequestContext()` can't derive it (a channel-task run has no
   * `ActiveWorkflow` row), so the workflow threads it from the run request.
   */
  channelId?: string;
  /**
   * Channel assistant (Phase C): soft steering guidance the interpreter drained
   * from the `steer` signal buffer before invoking this agent node. When present,
   * it is prepended to the user message as a clearly-labeled block so the agent
   * incorporates the new direction. SOFT semantics: this only reaches the NEXT
   * agent node after the signal arrived — an already-running node is not preempted.
   */
  steering?: string[];
  /**
   * Set when the node asks for a workspace (`workspace: true`): the run's
   * repository (null for a run without one, which fails the node), its ticket
   * id, and the branch its code result names, if any. The branch defaults to
   * `<branchPrefix>/<ticketId>`, as the quality gates' does. `baseBranch` is the run's
   * base (unset: the repository's default branch), which the checkout falls back to
   * before the run has pushed a branch.
   */
  workspace?: { baseBranch?: string; branch?: string; repoId: string | null; ticketId: string };
}

export interface RunAgentNodeResult {
  text?: string;
  object?: unknown;
}

/**
 * Temporal activity backing the declarative `agent` workflow node (P2). Resolves
 * the `agentRef` into an {@link AgentSpec} through the P1 Agent library
 * (`resolveAgentSpec` → `resolveAgent`, honoring the run-start version snapshot
 * and any explicit `@version` pin) and runs it via the P0 `runAgent` loop.
 *
 * No workspace tools are attached to a generic agent node, but MCP tools bind
 * when the resolved Agent enables them (`'mcp'` toolKey + `mcpConnectionId`) —
 * the generic counterpart to the implementer's `buildImplementerForActivity`.
 *
 * The node's runtime is resolved like every agent's (`resolveAgentRuntime`,
 * default Mastra), so it reads and writes the run's pin. Without a workspace
 * there is nothing for a harness to run in, so such a node always runs on
 * Mastra; an Agent pinned to a harness gets an `agent.runtime_not_applicable`
 * event on the trace saying so. A node that asks for a workspace runs in a
 * checkout instead (see {@link runInCheckout}), on whichever runtime was pinned.
 */
export async function runAgentNode(input: RunAgentNodeInput): Promise<RunAgentNodeResult> {
  // Heartbeats while the whole activity runs: its LLM call can outlast the
  // heartbeat timeout, and a heartbeat is how a cancellation reaches it.
  return withHeartbeat('runAgentNode', runAgentNodeImpl(input));
}

async function runAgentNodeImpl(input: RunAgentNodeInput): Promise<RunAgentNodeResult> {
  const baseCtx = await currentRequestContext();
  // Phase A: a channel-task run carries its originating channelId on the request
  // (not derivable from `currentRequestContext`, which keys on ActiveWorkflow).
  // Thread it in so the CHANNEL config tier fires for per-channel tools/MCP/model;
  // the channel's team and org come with it, since a repo-less run has no ledger row.
  const ctx = await withChannelScope(baseCtx, input.channelId);
  const { key, version } = parseAgentRef(input.agentRef);

  // An explicit `@version` pin overrides the run-start snapshot for this key.
  const resolveCtx =
    version !== undefined
      ? { ...ctx, agentVersions: { ...(ctx.agentVersions ?? {}), [key]: version } }
      : ctx;

  const baseMessage = input.userMessage ?? inputsToMessage(input.inputs);
  const userMessage = prependSteering(baseMessage, input.steering);

  // The tracer is created before the try and everything that writes to it runs
  // inside, so the MCP connection rows `loadMcpTools` records persist even when
  // the binding or the run throws. Whatever the node opens (the MCP client, a
  // harness session, the checkout) is released in finally, last opened first.
  const tracer = new AgentTracer();
  const opened: (() => Promise<void>)[] = [];
  const onOpen = (close: () => Promise<void>) => {
    opened.push(close);
  };
  try {
    // Pinned on the run like any agent's runtime, so a node and every later
    // resolution of the same agent in this run agree on it.
    const loop = await resolveAgentRuntime(key, resolveCtx, 'mastra');
    if (input.workspace) {
      return await runInCheckout({
        input,
        key,
        loop,
        onOpen,
        resolveCtx,
        tracer,
        userMessage,
        workspace: input.workspace,
      });
    }
    if (loop.runtime !== 'mastra') {
      tracer.addActivityEvent({
        name: 'agent.runtime_not_applicable',
        outputJson: {
          agentKey: key,
          ranOn: 'mastra',
          reason: 'no workspace',
          runtime: loop.runtime,
          source: loop.source,
        },
      });
    }

    // `key` is free-form (a template-declared agent key); the resolver input is
    // typed to the SWE role union. basePrompt is empty — the Agent supplies its
    // own system prompt (custom agents set one; sub-roles inherit).
    const spec = await resolveAgentSpec(
      { agentKey: key as ModelBackedAgentKey, basePrompt: '', promptOverride: input.systemPrompt },
      resolveCtx
    );
    // loadMcpTools is failure-isolated, so a bad server degrades to no tools.
    const mcpTools = await bindMcpTools(key, resolveCtx, tracer, onOpen);
    if (mcpTools) {
      // Built-in/spec tools win over MCP tools on key collision.
      spec.tools = { ...mcpTools, ...spec.tools } as AgentTools;
    }

    // One tracer for the MCP tool rows and the loop's rows, so they share one
    // `seq` sequence and persist once. The MCP tools record their own calls;
    // every other tool's calls are recorded from the loop's steps.
    const result = await runAgent(spec, userMessage, {
      ctx: resolveCtx,
      selfRecordingTools: boundToolKeys(spec.tools, mcpTools),
      spanName: input.spanName ?? 'llm.agent_node',
      tracer,
    });
    return { object: result.object, text: result.text };
  } finally {
    for (const close of opened.reverse()) {
      await close();
    }
    await persistActivityTrace(tracer, key);
  }
}

/** The Agent's MCP tools, when it enables them; their client's `close` is handed to `onOpen`. */
async function bindMcpTools(
  key: string,
  ctx: ResolveCtx,
  tracer: AgentTracer,
  onOpen: (close: () => Promise<void>) => void
): Promise<AgentTools | undefined> {
  const mcpTarget = await resolveAgentMcpUrl(key, ctx);
  if (!mcpTarget) {
    return undefined;
  }
  const loaded = await loadMcpTools(mcpTarget.url, tracer, {
    allowPrivateNetwork: mcpTarget.allowPrivateNetwork,
    bearerToken: mcpTarget.bearerToken,
    callTimeoutMs: mcpTarget.callTimeoutMs,
    headers: mcpTarget.headers,
    listTimeoutMs: mcpTarget.listTimeoutMs,
  });
  onOpen(loaded.close);
  return loaded.tools as AgentTools;
}

/**
 * A node that asks for a workspace (`workspace: true`): the Agent runs in a
 * throwaway checkout of the run's repository, on the runtime the run pinned for
 * it — the Mastra loop or a harness — and its answer is its final text.
 *
 * Both loops get the workspace tools an agent run grants (`grantedWorkspaceToolIds`:
 * `null` → the read tools, a list → exactly what it names), never the
 * implementer's "no opinion means everything", and a harness decides every call
 * through the same worker-side policy as an implementer's. Nothing the agent
 * changes leaves the container: the node commits and pushes nothing, and the
 * checkout is destroyed when the node ends.
 *
 * The model is checked against a USD cap, and bound to the harness, before the
 * clone, so a model the harness cannot drive is refused before any container
 * exists.
 */
async function runInCheckout(args: {
  input: RunAgentNodeInput;
  key: string;
  loop: ResolvedAgentRuntime;
  onOpen: (close: () => Promise<void>) => void;
  resolveCtx: ResolveCtx;
  tracer: AgentTracer;
  userMessage: string;
  workspace: NonNullable<RunAgentNodeInput['workspace']>;
}): Promise<RunAgentNodeResult> {
  const { input, key, loop, onOpen, resolveCtx, tracer } = args;
  if (!args.workspace.repoId) {
    throw ApplicationFailure.nonRetryable(
      `Agent node '${input.agentRef}' asks for a workspace, but its run has no repository.`,
      'AGENT_NODE_NO_REPOSITORY'
    );
  }
  const resolved = await resolveAgent(key, resolveCtx);
  await assertModelPricedForUsdCap(resolved.model.spec, { channelId: resolveCtx.channelId });
  const harness =
    loop.runtime === 'mastra'
      ? undefined
      : HARNESSES.select(loop.runtime).bind(key, resolved.model);

  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { host: true, installationId: true } } },
    where: { id: args.workspace.repoId },
  });
  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);
  throwIfActivityCancelled();
  // The run's branch, as the quality gates read it: the one its code result
  // names, else `<branchPrefix>/<ticketId>`. The checkout is cut from the run's base
  // branch and moved to the run's branch when the run has pushed one, so a node
  // that runs before any code exists reads the base branch.
  const branch =
    args.workspace.branch ??
    `${(await resolveWorkflowDefaults()).branchPrefix}/${args.workspace.ticketId}`;
  const baseBranch = await resolveRunBaseBranch(args.workspace.baseBranch, repo);
  // The clone credential is never written into the container: only `gitAuthed`
  // injects it, and only here, before the agent has started.
  const workspace = await createWorkspace(
    authedCloneUrl,
    branch,
    baseBranch,
    repo.executorImage ?? undefined
  );
  onOpen(workspace.destroy);
  let checkedOut = branch;
  try {
    await workspace.gitAuthed(fetchBranchesSubcommand([branch]));
    await workspace.exec(`git reset --hard origin/${shellQuote(branch)}`);
  } catch {
    checkedOut = baseBranch;
  }
  tracer.addActivityEvent({
    name: 'agent.runtime',
    outputJson: {
      agentKey: key,
      checkout: checkedOut,
      runtime: loop.runtime,
      source: loop.source,
    },
  });

  const spanName = input.spanName ?? 'llm.agent_node';
  if (harness) {
    const spec = await resolveAgentSpec(
      { agentKey: key as ModelBackedAgentKey, basePrompt: '', promptOverride: input.systemPrompt },
      resolveCtx
    );
    const runtime = harness.build({
      exactToolKeys: grantedWorkspaceToolIds(resolved.toolKeys),
      loadProjectSettings: true,
      maxTurns: await resolveSetting('workspace.agentMaxSteps', resolveCtx),
      // The connection the Mastra loop would bind, relayed from the worker.
      mcp: await resolveAgentMcpUrl(key, resolveCtx),
      tracer,
      workspace,
    });
    onOpen(async () => {
      await runtime.close?.();
    });
    throwIfActivityCancelled();
    await assertBudgetAvailable(`agent.${key}`);
    const turn = await runImplementerTurn({
      context: { agentNode: input.agentRef },
      role: key,
      runtime,
      system: `${spec.systemPrompt}\n\n${CHECKOUT_PREAMBLE}`.trim(),
      tracer,
      usageEvent: spanName,
      user: args.userMessage,
    });
    return { text: turn.text };
  }

  const maxToolOutputChars = await resolveSetting('workspace.maxToolOutputChars', resolveCtx);
  const built = buildWorkspaceTools(workspace, tracer, maxToolOutputChars);
  const spec = await resolveAgentSpec(
    {
      agentKey: key as ModelBackedAgentKey,
      availableTools: selectAgentRunTools(built, resolved.toolKeys) as unknown as AgentTools,
      basePrompt: '',
      promptOverride: input.systemPrompt,
    },
    resolveCtx
  );
  spec.systemPrompt = `${spec.systemPrompt}\n\n${CHECKOUT_PREAMBLE}`.trim();
  const mcpTools = await bindMcpTools(key, resolveCtx, tracer, onOpen);
  if (mcpTools) {
    spec.tools = { ...mcpTools, ...spec.tools } as AgentTools;
  }
  throwIfActivityCancelled();
  const result = await runAgent(spec, args.userMessage, {
    ctx: resolveCtx,
    // The workspace and MCP tools record their own calls on this tracer; any
    // other tool's calls are recorded from the loop's steps.
    selfRecordingTools: boundToolKeys(spec.tools, built, mcpTools),
    spanName,
    tracer,
  });
  return { object: result.object, text: result.text };
}

/** Appended to the system prompt of a node that runs in a checkout. */
const CHECKOUT_PREAMBLE = [
  'You are working in a throwaway checkout of the repository, rooted at the current directory.',
  'Use only the tools you were given. Nothing you change here is kept, committed or pushed: your answer is your final message.',
].join('\n');

/**
 * Turn the resolved node inputs into the agent's user message when no literal
 * `userMessage` was set. A SINGLE string input (e.g. the Channel Task spec's
 * `task` description) is sent as the plain string — sending `{"task":"…"}` as
 * JSON degrades prompt quality and pollutes any prepended steering block.
 * Anything else (multiple inputs, non-string values) keeps the structured JSON
 * payload so multi-input agent nodes still get the full object.
 */
function inputsToMessage(inputs: Record<string, unknown> | undefined): string {
  if (!inputs) {
    return '{}';
  }
  const values = Object.values(inputs);
  if (values.length === 1 && typeof values[0] === 'string') {
    return values[0];
  }
  return JSON.stringify(inputs);
}

/**
 * Append the steering messages as a labeled block after the base user message so
 * the agent treats them as new direction to incorporate. Empty/absent steering
 * leaves the message untouched.
 */
function prependSteering(message: string, steering: string[] | undefined): string {
  if (!steering || steering.length === 0) {
    return message;
  }
  const block = steering.map((s) => `- ${s}`).join('\n');
  return `${message}\n\n[Steering update from the channel — incorporate this]:\n${block}`;
}
