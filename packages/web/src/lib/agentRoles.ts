export const AGENT_ROLES = [
  'IMPLEMENTER',
  'REVIEWER',
  'PLANNER',
  'SECURITY_REVIEW',
  'VALIDATE_CONTEXT',
  'COMMIT_TO_MEMORY',
] as const;

export type AgentRoleKey = (typeof AGENT_ROLES)[number];

export const ROLE_LABELS: Record<string, string> = {
  COMMIT_TO_MEMORY: 'Commit to Memory',
  IMPLEMENTER: 'Implementer',
  PLANNER: 'Planner',
  REVIEWER: 'Reviewer',
  SECURITY_REVIEW: 'Security Review',
  VALIDATE_CONTEXT: 'Validate Context',
} satisfies Record<AgentRoleKey, string>;

export const ROLES_WITH_TOOLS = new Set<string>(['IMPLEMENTER']);
