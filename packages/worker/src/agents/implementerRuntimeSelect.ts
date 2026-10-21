import type { ImplementerRuntimeKind } from '@auto-swe/shared/types/api';
import type { Workspace } from '../activities/workspace.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { type AgentRuntimeSource, resolveAgentRuntime } from '../lib/config/agentRuntime.js';
import { type ResolvedSkill, skillsToPromptSuffix } from '../lib/config/agentSkills.js';
import type { ResolveCtx } from '../lib/config/types.js';
import { getBoundModel } from '../lib/models.js';
import { HARNESSES } from './harnessRegistry.js';
import {
  buildImplementerForActivity,
  resolveImplementerConfig,
  resolveImplementerMcpTarget,
} from './implementer.js';
import { type ImplementerRuntime, mastraRuntime } from './implementerRuntime.js';
import { isMcpToolEnabled } from './mcpTools.js';

/** One implementer session's loop, built for the runtime the agent resolved to. */
export interface ImplementerTurnRunner {
  /** The resolved `Agent` row the session runs as; pass it to `runImplementerTurn`. */
  agent: { id: string; version: number };
  /**
   * The `<provider>/<model>` spec of that same resolution. Pass it as `boundModelSpec` so the
   * turn is priced and traced at the model of the version named by `agent`; left out, usage
   * re-resolves the role every turn and a version cut mid-session pairs one id with another's model.
   */
  boundModelSpec: string;
  /** Drives each turn; pass it to `runImplementerTurn`. */
  runtime: ImplementerRuntime;
  /** Which loop `runtime` is — what the session actually ran on. */
  kind: ImplementerRuntimeKind;
  /** What chose it: the run's pin, the Agent version, or the setting. */
  kindSource: AgentRuntimeSource;
  /**
   * What this runtime needs appended to the system prompt: the Mastra loop's
   * skill menu (it discloses skills through a `loadSkill` tool), or each
   * skill's text inline for the harness, which has no such tool. `''` when the
   * agent has no skills.
   */
  promptSuffix: string;
  skills: ResolvedSkill[];
  /** The `workspace.agentMaxSteps` budget the runtime was built with. */
  maxSteps: number;
  /** The effective tool keys, persona narrowing applied (`null` = every tool). */
  toolKeys: string[] | null;
  /** `base` with `promptSuffix` appended. */
  systemPrompt(base: string): string;
  /**
   * Releases what the runtime opened (the Mastra loop's MCP client, or what a
   * harness adapter holds across turns). Safe to call more than once; callers
   * MUST call it in a `finally` block.
   */
  close(): Promise<void>;
}

/**
 * Builds the loop that drives an implementer session. The agent's runtime is
 * resolved FIRST (`resolveAgentRuntime`: the Agent version's own `runtime`, else
 * the run-pinned `workspace.implementerRuntime`; pinned on the run at first use)
 * and only what that runtime uses is built: the
 * Mastra agent, its model binding and its MCP connection for `mastra`; for any
 * other value, the harness the registry (`harnessRegistry.ts`) holds for it,
 * bound to the Agent's own model and credential. A harness brings its own tools
 * and never binds a Mastra model; the Agent's MCP connection is relayed to it
 * from the worker. The registry only
 * holds harnesses whose every tool call the worker decides, and refuses the rest.
 *
 * Every runtime runs on the same Agent row's config (`resolveImplementerConfig`):
 * its tool keys — narrowed for a persona — skills, and step budget.
 *
 * The choice is steered only through pins, never a parameter: a run's own
 * `WorkflowRun.agentRuntimes` pin, or the per-agent pin an eval case builds from
 * its run's per-side runtime override (`ctx.agentRuntimes`), which wins over the
 * Agent's own runtime; else the Agent version, else the setting (itself pinned
 * through `ctx.pinnedSettings`).
 *
 * Build one per session, not per turn: a runtime that resumes its session across
 * turns (the harness) keeps its context and its prompt cache only while the same
 * runner is reused.
 */
export async function buildImplementerTurnRunner(input: {
  agentKey?: string;
  ctx?: ResolveCtx;
  tracer: AgentTracer;
  workspace: Workspace;
  /**
   * The repository the session works on. Under the Mastra loop the agent gets
   * read-only memory tools over its lessons; the harness has its own tool set.
   */
  repoId?: string;
}): Promise<ImplementerTurnRunner> {
  const agentKey = input.agentKey ?? 'implementer';
  const { runtime: kind, source: kindSource } = await resolveAgentRuntime(
    agentKey,
    input.ctx,
    'implementerSetting'
  );
  // Which loop ran, and why, sits on the session's trace beside its turns.
  input.tracer.addActivityEvent({
    name: 'agent.runtime',
    outputJson: { agentKey, runtime: kind, source: kindSource },
  });

  if (kind === 'mastra') {
    // One resolution binds the model that runs and names the Agent row that is stamped on its
    // trace rows, so a version cut mid-session cannot pair one version's id with another's model.
    const bound = await getBoundModel(agentKey, input.ctx);
    const built = await buildImplementerForActivity(
      input.workspace,
      input.tracer,
      input.ctx,
      agentKey,
      input.repoId,
      bound.model
    );
    return runner({
      agent: bound.agent,
      boundModelSpec: bound.spec,
      close: built.closeMcp,
      kind,
      kindSource,
      maxSteps: built.maxSteps,
      promptSuffix: built.promptSuffix,
      runtime: mastraRuntime(built.agent, built.maxSteps),
      skills: built.skills,
      toolKeys: built.toolKeys,
    });
  }

  const resolvedAgent = await resolveAgent(agentKey, input.ctx);
  const agent = { id: resolvedAgent.id, version: resolvedAgent.version };
  const boundModelSpec = resolvedAgent.model.spec;
  const harness = HARNESSES.select(kind);
  const { model } = resolvedAgent;
  const [config, mcpTarget] = await Promise.all([
    resolveImplementerConfig(input.ctx, agentKey),
    resolveImplementerMcpTarget(agentKey, input.ctx, input.tracer),
  ]);
  const runtime = harness.bind(agentKey, model).build({
    // The repository's own harness configuration (Claude Code's CLAUDE.md and
    // `.claude` settings) applies, so a flow ported from a developer machine
    // behaves as it did there. Its hooks run in the container; the worker-side
    // policy still decides every tool call.
    harnessContextTokens: config.harnessContextTokens,
    loadProjectSettings: true,
    maxToolOutputChars: config.maxToolOutputChars,
    maxTurns: config.maxSteps,
    // The same MCP connection the Mastra loop would bind, relayed from the worker.
    mcp: isMcpToolEnabled(config.toolKeys) ? mcpTarget : null,
    // The Agent row's tools bound the harness as they bound the Mastra loop.
    toolKeys: config.toolKeys,
    tracer: input.tracer,
    workspace: input.workspace,
  });
  return runner({
    agent,
    boundModelSpec,
    close: runtime.close,
    kind: harness.kind,
    kindSource,
    maxSteps: config.maxSteps,
    promptSuffix: skillsToPromptSuffix(config.skills) ?? '',
    runtime,
    skills: config.skills,
    toolKeys: config.toolKeys,
  });
}

function runner(parts: {
  agent: { id: string; version: number };
  boundModelSpec: string;
  close?: () => Promise<void>;
  kind: ImplementerRuntimeKind;
  kindSource: AgentRuntimeSource;
  maxSteps: number;
  promptSuffix: string;
  runtime: ImplementerRuntime;
  skills: ResolvedSkill[];
  toolKeys: string[] | null;
}): ImplementerTurnRunner {
  const { close, promptSuffix, ...rest } = parts;
  let closed: Promise<void> | undefined;
  return {
    ...rest,
    close: () => {
      closed ??= close?.() ?? Promise.resolve();
      return closed;
    },
    promptSuffix,
    systemPrompt: (base) => (promptSuffix ? `${base}\n\n${promptSuffix}` : base),
  };
}
