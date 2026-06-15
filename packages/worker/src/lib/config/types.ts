/// Canonical agent identity. Since the platform pivot (P0), agent identity is
/// a free-form camelCase string stored directly in the DB (no `AgentRole`
/// enum). This union is the canonical set of SWE agent keys; the DB column
/// accepts any string so new agents can be added as data.
///
/// These 6 roles require a GLOBAL ModelRoleConfig row at worker startup
/// (checked by `assertConfigReady`).
export type AgentRole =
  | 'implementer'
  | 'reviewer'
  | 'planner'
  | 'securityReview'
  | 'validateContext'
  | 'commitToMemory';

/// Skill-only sub-roles. These do NOT require ModelRoleConfig rows — they
/// inherit the model from their parent role (e.g. securityReviewer inherits
/// from reviewer). They exist solely so skills can be assigned at per-reviewer
/// or per-decomposer granularity.
export type SkillOnlyRole =
  | 'securityReviewer'
  | 'domainLogicReviewer'
  | 'performanceReviewer'
  | 'decomposer';

/// Any role that can have AgentSkillAssignment rows.
export type AnySkillRole = AgentRole | SkillOnlyRole;

/// Canonical iteration order for the 6 agent roles. Used by the worker
/// startup check, the seed helpers (where they still exist), and any test
/// that wants to assert behavior across every role.
export const ALL_ROLES: readonly AgentRole[] = [
  'implementer',
  'reviewer',
  'planner',
  'securityReview',
  'validateContext',
  'commitToMemory',
] as const;

/// Optional scoping context for config resolution. When unset, only the
/// GLOBAL row is consulted.
export interface ResolveCtx {
  teamId?: string;
  workflowTemplateId?: string;
}

/// Resolved model + credential for a single role lookup. Returned by
/// `resolveModelConfig`. `apiKey` is the decrypted plaintext; callers should
/// pass it straight into the provider client and not log it.
export interface ResolvedModelConfig {
  /** `<provider>/<model-id>` spec the agent should bind to. */
  spec: string;
  /** Which scope row supplied the spec — for OTel attribution. */
  scope: 'WORKFLOW_TEMPLATE' | 'TEAM' | 'GLOBAL';
  /** Plaintext API key from the resolved credential. */
  apiKey: string;
  /** Base URL override from the resolved credential. */
  apiBase?: string;
  /**
   * Optional system prompt override. `undefined` means use the hardcoded
   * constant in prompts.ts. Set on the ModelRoleConfig row via the admin UI.
   */
  systemPrompt?: string;
}
