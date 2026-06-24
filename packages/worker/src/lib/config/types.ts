/// The six seeded SWE model-backed agent keys + their canonical iteration
/// order. Re-exported from the shared single source (`@auto-swe/shared/agentKeys`)
/// so the worker and web dashboard agree. Since the platform pivot (P0) there is
/// no `AgentRole` *enum* — agent identity is a free-form string (`AnySkillRole`
/// below); `ModelBackedAgentKey` is just the narrow convenience set of agents
/// that carry their own `modelSpec` (so they need a GLOBAL `Agent` at worker boot,
/// drive cost pricing, and get a model-config UI label).
export { MODEL_BACKED_AGENT_KEYS, type ModelBackedAgentKey } from '@auto-swe/shared/agentKeys';

/// Any agent key that can have skill/tool assignments. Free-form since the
/// platform pivot: sub-reviewer and decomposer personas (formerly the
/// `SkillOnlyRole` union — `securityReviewer`, `domainLogicReviewer`,
/// `performanceReviewer`, `decomposer`) are now ordinary Agents resolved by
/// key, inheriting their model from a parent role via the Agent's
/// `inheritsModelFrom` pointer (P1/WS2). New personas are data, not a union.
export type AnySkillRole = string;

/// Optional scoping context for config resolution. When unset, only the
/// GLOBAL row is consulted.
export interface ResolveCtx {
  teamId?: string;
  /// P5: the owning Organization (derived from the team's org). Inserts an
  /// ORGANIZATION tier between TEAM and GLOBAL in every config cascade. The tier
  /// only fires when set, so GLOBAL/TEAM-only deployments behave unchanged.
  orgId?: string;
  /// Channel assistant: the SlackChannel a channel-resident assistant is running in.
  /// Inserts a CHANNEL tier between WORKFLOW_TEMPLATE and TEAM in the agent
  /// cascade. Only fires when set, so non-Slack runs behave unchanged.
  channelId?: string;
  workflowTemplateId?: string;
  /// P1/WS3 run-start Agent-version pins (`{ agentKey: version }`). When present
  /// for a key, `resolveAgent` resolves that exact Agent version instead of the
  /// latest active one, freezing the run against later Agent edits.
  agentVersions?: Record<string, number>;
}

/// Resolved model + credential for a single role lookup. Returned by
/// `resolveAgent`. `apiKey` is the decrypted plaintext; callers should
/// pass it straight into the provider client and not log it.
export interface ResolvedModelConfig {
  /** `<provider>/<model-id>` spec the agent should bind to. */
  spec: string;
  /** Which scope row supplied the spec — for OTel attribution. */
  scope: 'WORKFLOW_TEMPLATE' | 'CHANNEL' | 'TEAM' | 'ORGANIZATION' | 'GLOBAL';
  /** Plaintext API key from the resolved credential. */
  apiKey: string;
  /** Base URL override from the resolved credential. */
  apiBase?: string;
  /**
   * Optional system prompt override. `undefined` means use the hardcoded
   * constant in prompts.ts. Set on the `Agent` row via the admin UI.
   */
  systemPrompt?: string;
}

/// A skill (prompt fragment) resolved for an agent, with ordering. Lives here
/// (rather than in agentSkills.ts) so the resolver layers can share the type
/// without an import cycle.
export interface ResolvedSkill {
  id: string;
  name: string;
  description: string;
  promptText: string;
  sortOrder: number;
  isVerified: boolean;
}
