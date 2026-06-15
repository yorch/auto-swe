export const AGENT_ROLES = [
  'implementer',
  'reviewer',
  'planner',
  'securityReview',
  'validateContext',
  'commitToMemory',
] as const;

export type AgentRoleKey = (typeof AGENT_ROLES)[number];

export const ROLE_LABELS: Record<string, string> = {
  commitToMemory: 'Commit to Memory',
  implementer: 'Implementer',
  planner: 'Planner',
  reviewer: 'Reviewer',
  securityReview: 'Security Review',
  validateContext: 'Validate Context',
} satisfies Record<AgentRoleKey, string>;

export const ROLES_WITH_TOOLS = new Set<string>(['implementer']);
