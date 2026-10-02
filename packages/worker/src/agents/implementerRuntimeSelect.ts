import { resolveSetting } from '@auto-swe/shared/config';
import type { Agent } from '@mastra/core/agent';
import { ApplicationFailure } from '@temporalio/activity';
import type { Workspace } from '../activities/workspace.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { type ResolvedSkill, skillsToPromptSuffix } from '../lib/config/agentSkills.js';
import type { ResolveCtx } from '../lib/config/types.js';
import { claudeCodeRuntime } from './claudeCode/runtime.js';
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

/**
 * Chooses the loop that drives an implementer turn, from the run-pinned
 * `workspace.implementerRuntime` setting, and the prompt suffix that loop needs.
 *
 * The suffix differs because the Mastra loop discloses skills progressively
 * through a `loadSkill` tool, which the harness does not have: it gets each
 * skill's text inline instead.
 *
 * `agent` is the Mastra agent the caller already built. It is unused under the
 * harness, which brings its own tools.
 */
export async function selectImplementerRuntime(input: {
  agent: Pick<Agent, 'generate'>;
  agentKey: string;
  ctx?: ResolveCtx;
  maxSteps: number;
  promptSuffix: string;
  skills: ResolvedSkill[];
  tracer: AgentTracer;
  workspace: Workspace;
}): Promise<{ promptSuffix: string; runtime: ImplementerRuntime }> {
  const kind = await resolveSetting('workspace.implementerRuntime', input.ctx);
  if (kind === 'mastra') {
    return {
      promptSuffix: input.promptSuffix,
      runtime: mastraRuntime(input.agent, input.maxSteps),
    };
  }
  return {
    promptSuffix: skillsToPromptSuffix(input.skills) ?? '',
    runtime: claudeCodeRuntime({
      access: await resolveClaudeCodeAccess(input.agentKey, input.ctx),
      // The repository's own CLAUDE.md and `.claude` settings apply, so a flow ported
      // from a developer machine behaves as it did there. Its hooks run in the
      // container; the worker-side policy still decides every tool call.
      loadProjectSettings: true,
      maxTurns: input.maxSteps,
      tracer: input.tracer,
      workspace: input.workspace,
    }),
  };
}
