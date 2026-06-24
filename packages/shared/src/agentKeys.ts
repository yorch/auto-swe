/**
 * The seeded SWE **model-backed agent keys** — the canonical single source of
 * truth shared by the worker and the web dashboard.
 *
 * Since the platform pivot (P0) there is no `AgentRole` *enum*: agent identity
 * is a free-form camelCase string (`AnySkillRole = string`) stored directly in
 * the DB, so new agents are added as data. This list is **not** that universe —
 * it is the narrow convenience set of the six SWE agents that are *model-backed*
 * (each has its own `modelSpec` and therefore requires a GLOBAL `Agent` row at
 * worker boot, drives cost pricing, and gets a label in the model-config UI).
 * Sub-role personas (`securityReviewer`, `decomposer`, …) are ordinary Agents
 * that inherit a model via `inheritsModelFrom` and are intentionally absent here.
 */
export const MODEL_BACKED_AGENT_KEYS = [
  'implementer',
  'reviewer',
  'planner',
  'securityReview',
  'validateContext',
  'commitToMemory',
  // Channel assistant (Phase 0): the per-channel Slack assistant. Model-backed (its own
  // `modelSpec`) so it drives cost pricing + gets a model-config label. It is
  // NOT in `requiredAgentKeys()` (no workflow step needs it), so it does not gate
  // worker boot via `assertConfigReady`; `syncBuiltins` seeds its GLOBAL Agent.
  'channelAssistant',
] as const;

/** One of the six seeded SWE model-backed agent keys. */
export type ModelBackedAgentKey = (typeof MODEL_BACKED_AGENT_KEYS)[number];
