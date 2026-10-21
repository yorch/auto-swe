import type { ReasoningLevel } from '@auto-swe/shared/types/api';
import type { Agent } from '@mastra/core/agent';
import type { z } from 'zod';
import { resolveModel } from '../models.js';
import { type ResolvedAgent, resolveAgent } from './agentResolver.js';
import { type ResolvedSkill, skillsToPromptSuffix } from './agentSkills.js';
import type { ModelBackedAgentKey, ResolveCtx } from './types.js';

/**
 * `AgentSpec` is the single normalized description of "run an agent": which
 * model to bind, the fully-composed system prompt (base + skill suffix), the
 * resolved skills, the enabled tools, and an optional structured-output schema.
 *
 * It is produced by {@link resolveAgentSpec} (which composes the existing
 * `resolveAgent` + `loadAgentSkills` + `loadAgentToolConfig` +
 * `skillsToPromptSuffix`) and consumed by the generic `runAgent` loop. Carrying
 * a built `model` (rather than a `<provider>/<model>` spec + plaintext key)
 * keeps decrypted credentials out of the spec object and means `runAgent` never
 * re-touches the DB. The spec contains live, non-serializable handles (`model`,
 * `tools`) so it is an in-process value — never a Temporal activity argument.
 */
export interface AgentSpec {
  /** Identity string for tracing + cost attribution (e.g. `validateContext`). */
  agentKey: string;
  /** Resolved `<provider>/<model>` spec, for OTel attribution. */
  modelSpec: string;
  /**
   * The resolved `Agent` row (id + version) the spec was composed from; stamped on the trace
   * rows of its LLM calls. `null` for an inline agent, which is not an `Agent` row.
   */
  agent: { id: string; version: number } | null;
  /** Bound language model, ready to hand to a Mastra `Agent`. */
  model: LanguageModel;
  /** Fully composed system prompt: base prompt followed by the skill suffix. */
  systemPrompt: string;
  /** Resolved skills (for progressive disclosure / L1 menus in tool agents). */
  skills: ResolvedSkill[];
  /** Resolved Mastra tools keyed by id. Empty when the agent uses no tools. */
  tools: AgentTools;
  /** Structured-output schema, when the agent returns a typed object. */
  outputSchema?: z.ZodTypeAny;
  /** Memory scope key (reserved for the P2 `agent` node). */
  memoryScope?: string;
}

/** Bound language-model instance type, derived from the model builder. */
type LanguageModel = ReturnType<typeof resolveModel>;

/** Mastra tool-map type, derived from the `Agent` constructor's `tools` field. */
export type AgentTools = NonNullable<ConstructorParameters<typeof Agent>[0]['tools']>;

/**
 * A fully data-specified agent — every field supplied by the caller rather than
 * resolved from a DB role. This is the path the P2 `agent` node will use for
 * agents defined as configuration. The credential (`apiKey`/`apiBase`) is
 * resolved by the caller and bound here into a `model`.
 */
export interface InlineAgentSpec {
  /** Attribution key; defaults to `inlineAgent` when omitted. */
  agentKey?: string;
  modelSpec: string;
  apiKey: string;
  apiBase?: string;
  /** How hard the model reasons; absent = the provider's default. */
  reasoning?: ReasoningLevel | null;
  systemPrompt: string;
  skills?: ResolvedSkill[];
  tools?: AgentTools;
  outputSchema?: z.ZodTypeAny;
  memoryScope?: string;
}

/** Resolve from a known model-backed agent key (its `Agent` carries a `modelSpec`). */
export interface AgentKeySpecInput {
  agentKey: ModelBackedAgentKey;
  /** Fallback system prompt used when no DB/override prompt is configured. Defaults to ''. */
  basePrompt?: string;
  /** Explicit override (highest priority — e.g. a per-step prompt override). */
  promptOverride?: string;
  outputSchema?: z.ZodTypeAny;
  /**
   * Candidate tools by id. The result is the intersection with the role's
   * `AgentToolConfig`; a `null` config (no row) means "use all candidates",
   * matching {@link loadAgentToolConfig}'s convention. Omit for tool-free
   * agents (e.g. `validateContext`).
   */
  availableTools?: AgentTools;
  memoryScope?: string;
}

export type ResolveAgentSpecInput = AgentKeySpecInput | { inline: InlineAgentSpec };

/**
 * Intersect the caller-provided tools with the role's enabled-tool keys.
 * `null` enabled = use every candidate (the role has no `AgentToolConfig`).
 */
function selectTools(available: AgentTools | undefined, enabled: string[] | null): AgentTools {
  const empty = {} as AgentTools;
  if (!available) {
    return empty;
  }
  const pool = available as Record<string, unknown>;
  if (enabled === null) {
    const picked = Object.fromEntries(
      Object.entries(pool).filter(([key]) => key !== 'searchKnowledge' && key !== 'submitLearning')
    );
    return picked as AgentTools;
  }
  const picked: Record<string, unknown> = {};
  for (const key of enabled) {
    if (key in pool) {
      picked[key] = pool[key];
    }
  }
  return picked as AgentTools;
}

/**
 * The system prompt of a resolved Agent: explicit override → the version's prompt → `basePrompt`
 * (the priority of `resolveSystemPrompt`), then the skill suffix joined by a blank line. Exported
 * so a caller that already holds the resolution it binds a model from (a harness run) builds the
 * prompt from that same resolution instead of resolving the Agent a second time.
 */
export function composeAgentPrompt(
  agent: Pick<ResolvedAgent, 'model' | 'skills'>,
  opts: { basePrompt?: string; promptOverride?: string } = {}
): string {
  const base = opts.promptOverride ?? agent.model.systemPrompt ?? opts.basePrompt ?? '';
  const suffix = skillsToPromptSuffix(agent.skills);
  return suffix ? `${base}\n\n${suffix}` : base;
}

/**
 * Compose model + skills + tools + prompt into a single {@link AgentSpec}.
 *
 * For the role path this returns byte-identical model/skills/prompt to the
 * legacy per-call resolution (it wraps the very same helpers): the base prompt
 * follows the `promptOverride → DB systemPrompt → basePrompt` priority of
 * `resolveSystemPrompt`, and the skill suffix is appended with the same
 * double-newline join as `skillsToPromptSuffix`.
 */
export async function resolveAgentSpec(
  input: ResolveAgentSpecInput,
  ctx?: ResolveCtx
): Promise<AgentSpec> {
  if ('inline' in input) {
    const i = input.inline;
    return {
      agent: null,
      agentKey: i.agentKey ?? 'inlineAgent',
      memoryScope: i.memoryScope,
      model: resolveModel(i.modelSpec, i.apiKey, i.apiBase, i.reasoning),
      modelSpec: i.modelSpec,
      outputSchema: i.outputSchema,
      skills: i.skills ?? [],
      systemPrompt: i.systemPrompt,
      tools: i.tools ?? ({} as AgentTools),
    };
  }

  const {
    agentKey,
    basePrompt = '',
    promptOverride,
    outputSchema,
    availableTools,
    memoryScope,
  } = input;
  // P1.5: one resolution path. The first-class `Agent` is the sole source of
  // model/prompt/skills/tools (the legacy ModelRoleConfig / AgentSkillAssignment
  // / AgentToolConfig tables were removed), so the composed spec comes entirely
  // from the resolved Agent.
  const agent = await resolveAgent(agentKey, ctx);

  return {
    agent: { id: agent.id, version: agent.version },
    agentKey,
    memoryScope,
    model: resolveModel(
      agent.model.spec,
      agent.model.apiKey,
      agent.model.apiBase,
      agent.model.reasoning
    ),
    modelSpec: agent.model.spec,
    outputSchema,
    skills: agent.skills,
    systemPrompt: composeAgentPrompt(agent, { basePrompt, promptOverride }),
    tools: selectTools(availableTools, agent.toolKeys),
  };
}
