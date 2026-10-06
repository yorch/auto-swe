import type { ImplementerRuntimeKind } from '@auto-swe/shared/types/api';
import { ApplicationFailure } from '@temporalio/activity';
import type { Workspace } from '../activities/workspace.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { type AgentRuntimeSource, resolveAgentRuntime } from '../lib/config/agentRuntime.js';
import { type ResolvedSkill, skillsToPromptSuffix } from '../lib/config/agentSkills.js';
import type { ResolveCtx } from '../lib/config/types.js';
import { claudeCodeRuntime } from './claudeCode/runtime.js';
import { buildImplementerForActivity, resolveImplementerConfig } from './implementer.js';
import { type ImplementerRuntime, mastraRuntime } from './implementerRuntime.js';

const ANTHROPIC_PREFIX = 'anthropic/';

/**
 * The model and credential the harness runs on: the same Agent row, and the same
 * decrypted credential, the Mastra runtime would have used.
 *
 * Claude Code speaks the Anthropic Messages API, so the Agent's model must be an
 * Anthropic one. Pointing the credential's `apiBase` at a gateway that routes to
 * Anthropic is how a deployment sends the harness through its own gateway.
 */
export async function resolveClaudeCodeAccess(agentKey: string, ctx?: ResolveCtx) {
  const { model } = await resolveAgent(agentKey, ctx);
  if (!model.spec.startsWith(ANTHROPIC_PREFIX)) {
    throw ApplicationFailure.nonRetryable(
      `The claude-code runtime needs an Anthropic model, but agent '${agentKey}' resolves to '${model.spec}'. Set the agent's model to anthropic/<model>, or set its runtime (or workspace.implementerRuntime) back to mastra.`,
      'HARNESS_UNSUPPORTED_MODEL'
    );
  }
  return {
    apiBase: model.apiBase ?? undefined,
    apiKey: model.apiKey,
    modelId: model.spec.slice(ANTHROPIC_PREFIX.length),
  };
}

/** One implementer session's loop, built for the runtime the agent resolved to. */
export interface ImplementerTurnRunner {
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
   * Releases what the runtime opened (the Mastra loop's MCP client). Safe to
   * call more than once; callers MUST call it in a `finally` block.
   */
  close(): Promise<void>;
}

/**
 * Builds the loop that drives an implementer session. The agent's runtime is
 * resolved FIRST (`resolveAgentRuntime`: the Agent version's own `runtime`, else
 * the run-pinned `workspace.implementerRuntime`; pinned on the run at first use)
 * and only what that runtime uses is built: the
 * Mastra agent, its model binding and its MCP connection for `mastra`; the
 * Anthropic credential for `claude-code`, which brings its own tools and so
 * never opens the MCP client or binds a Mastra model.
 *
 * Both runtimes run on the same Agent row's config (`resolveImplementerConfig`):
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
    const built = await buildImplementerForActivity(
      input.workspace,
      input.tracer,
      input.ctx,
      agentKey
    );
    return runner({
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

  const [config, access] = await Promise.all([
    resolveImplementerConfig(input.ctx, agentKey),
    resolveClaudeCodeAccess(agentKey, input.ctx),
  ]);
  return runner({
    kind,
    kindSource,
    maxSteps: config.maxSteps,
    promptSuffix: skillsToPromptSuffix(config.skills) ?? '',
    runtime: claudeCodeRuntime({
      access,
      // The repository's own CLAUDE.md and `.claude` settings apply, so a flow ported
      // from a developer machine behaves as it did there. Its hooks run in the
      // container; the worker-side policy still decides every tool call.
      loadProjectSettings: true,
      maxTurns: config.maxSteps,
      // The Agent row's tools bound the harness as they bound the Mastra loop.
      toolKeys: config.toolKeys,
      tracer: input.tracer,
      workspace: input.workspace,
    }),
    skills: config.skills,
    toolKeys: config.toolKeys,
  });
}

function runner(parts: {
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
