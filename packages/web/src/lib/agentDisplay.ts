import type { AgentRow, AgentScope } from '@/hooks/useAgentLibrary';
import type { ReadinessProvider } from '@/hooks/useReadiness';

/** How an agent binds its model, for list views: its own spec, or whom it inherits from. */
export function modelLabel(a: Pick<AgentRow, 'modelSpec' | 'inheritsModelFrom'>): string {
  if (a.modelSpec) {
    return a.modelSpec;
  }
  if (a.inheritsModelFrom) {
    return `↳ inherits ${a.inheritsModelFrom}`;
  }
  return '— (role default)';
}

const SCOPE_LABELS: Record<AgentScope, string> = {
  CHANNEL: 'Slack channel',
  GLOBAL: 'Platform-wide',
  ORGANIZATION: 'Organization',
  TEAM: 'Team',
  WORKFLOW_TEMPLATE: 'Workflow',
};

/** The name a person reads for an agent scope; the wire values stay in requests. */
export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope as AgentScope] ?? scope;
}

export const SCOPE_ORDER: readonly AgentScope[] = [
  'GLOBAL',
  'ORGANIZATION',
  'TEAM',
  'CHANNEL',
  'WORKFLOW_TEMPLATE',
];

const SCOPE_HINTS: Record<AgentScope, string> = {
  CHANNEL: 'Applies only in one Slack channel.',
  GLOBAL: 'Applies everywhere unless a narrower scope overrides it.',
  ORGANIZATION: "Overrides the platform-wide agent for one organization's teams.",
  TEAM: 'Overrides the platform-wide agent for one team.',
  WORKFLOW_TEMPLATE: 'Overrides the agent only when one workflow runs.',
};

export function scopeHint(scope: AgentScope): string {
  return SCOPE_HINTS[scope];
}

/** What the tool list means to a person. */
export function toolKeysLabel(toolKeys: string[] | null): string {
  if (toolKeys === null) {
    return 'All tools';
  }
  if (toolKeys.length === 0) {
    return 'No tools';
  }
  return toolKeys.join(', ');
}

const providerOf = (spec: string | null | undefined): string | null =>
  spec?.split('/')[0]?.trim().toLowerCase() || null;

/**
 * The provider an agent will call that has no usable credential, or null. An agent pinned to its
 * own credential is covered; a sub-role persona has the status of the agent it inherits from
 * (the platform-wide one, since that is where a persona's parent is defined).
 */
export function missingCredentialProvider(
  agent: Pick<AgentRow, 'modelSpec' | 'inheritsModelFrom' | 'credentialId'>,
  agents: readonly Pick<AgentRow, 'key' | 'scope' | 'isActive' | 'modelSpec' | 'credentialId'>[],
  providers: readonly ReadinessProvider[]
): string | null {
  const source = agent.modelSpec
    ? agent
    : agents.find((a) => a.scope === 'GLOBAL' && a.isActive && a.key === agent.inheritsModelFrom);
  const provider = providerOf(source?.modelSpec);
  if (!(source && provider) || source.credentialId) {
    return null;
  }
  return providers.some((p) => p.provider === provider && !p.present) ? provider : null;
}
