import { resolveSetting } from '@auto-swe/shared/config';
import type { ImplementerRuntimeKind } from '@auto-swe/shared/types/api';
import { ApplicationFailure } from '@temporalio/activity';
import type { Workspace } from '../activities/workspace.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
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
async function resolveClaudeCodeAccess(agentKey: string, ctx?: ResolveCtx) {
  const { model } = await resolveAgent(agentKey, ctx);
  if (!model.spec.startsWith(ANTHROPIC_PREFIX)) {
    throw ApplicationFailure.nonRetryable(
      `The claude-code runtime needs an Anthropic model, but agent '${agentKey}' resolves to '${model.spec}'. Set the agent's model to anthropic/<model>, or switch workspace.implementerRuntime back to mastra.`,
      'HARNESS_UNSUPPORTED_MODEL'
    );
  }
  return {
    apiBase: model.apiBase ?? undefined,
    apiKey: model.apiKey,
    modelId: model.spec.slice(ANTHROPIC_PREFIX.length),
  };
}

/** One implementer session's loop, built for the runtime the setting chose. */
export interface ImplementerTurnRunner {
  /** Which runtime `workspace.implementerRuntime` chose — what the session actually ran on. */
  kind: ImplementerRuntimeKind;
  /** Drives each turn; pass it to `runImplementerTurn`. */
  runtime: ImplementerRuntime;
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
 * Builds the loop that drives an implementer session. `workspace.implementerRuntime`
 * (run-pinned) is resolved FIRST and only what that runtime uses is built: the
 * Mastra agent, its model binding and its MCP connection for `mastra`; the
 * Anthropic credential for `claude-code`, which brings its own tools and so
 * never opens the MCP client or binds a Mastra model.
 *
 * Both runtimes run on the same Agent row's config (`resolveImplementerConfig`):
 * its tool keys — narrowed for a persona — skills, and step budget.
 *
 * The choice goes through `resolveSetting` and nothing else, so the only way to
 * steer it is the run-pin tier: a run's `ctx.pinnedSettings` snapshot, or the pin
 * an eval case builds from its run's per-side runtime override. There is no
 * parameter that skips the setting.
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
  const kind = await resolveSetting('workspace.implementerRuntime', input.ctx);

  if (kind === 'mastra') {
    const built = await buildImplementerForActivity(
      input.workspace,
      input.tracer,
      input.ctx,
      agentKey
    );
    return runner({
      close: built.closeMcp,
      kind: 'mastra',
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
    kind: 'claude-code',
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
