/**
 * The config audit log is one feed with many entity types. These groups let a page open it on the
 * slice that matters there while the whole log stays one filter change away.
 */

import { humanizeKey } from '@/lib/govLabels';

export type AuditGroup = 'all' | 'models' | 'integrations' | 'settings';

const MODEL_TYPES = new Set([
  'Agent',
  'ProviderCredential',
  'EmbeddingConfig',
  'ModelCatalogEntry',
  'ModelSuggestion',
  'ModelRoleConfig',
  'Skill',
]);

const INTEGRATION_TYPES = new Set([
  'GitHubConfig',
  'SlackConfig',
  'IssueTrackerConfig',
  'KnowledgeBaseConfig',
  'FigmaConfig',
  'GoogleOAuthConfig',
  'OktaOAuthConfig',
  'StorageConfig',
  'GitHubInstallation',
  'GitHubHostCredential',
  'GitHubHostWebhookSecret',
  'Connection',
  // A Slack or email delivery of a join-request notice, and the retry an administrator queues.
  'JoinRequestNotification',
]);

/** Plain names for the entity types a config audit row carries. */
const ENTITY_LABELS: Record<string, string> = {
  Agent: 'Agent',
  AgentSkillAssignment: 'Agent skill assignment',
  AgentToolConfig: 'Agent tool config',
  CanaryConfig: 'Canary routing',
  ConfigSetting: 'Setting',
  Connection: 'Connection',
  ConsolidationConfig: 'Consolidation schedule',
  EmbeddingConfig: 'Embedding config',
  EvalScheduleConfig: 'Eval schedule',
  FigmaConfig: 'Figma',
  GitHubConfig: 'GitHub',
  GoogleOAuthConfig: 'Google OAuth',
  IssueTrackerConfig: 'Issue tracker',
  JoinRequestNotification: 'Join-request notification',
  KnowledgeBaseConfig: 'Knowledge base',
  ModelCatalogEntry: 'Model catalog',
  ModelRoleConfig: 'Model config',
  ModelSuggestion: 'Model suggestion',
  OktaOAuthConfig: 'Okta OAuth',
  ProviderCredential: 'Provider credential',
  RevalidationConfig: 'Revalidation schedule',
  Skill: 'Skill',
  SlackConfig: 'Slack',
  StorageConfig: 'Storage',
  WorkflowDefaults: 'Workflow defaults',
};

/** A plain name for an entity type; one with no entry is humanized, never printed raw. */
export function auditEntityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? humanizeKey(entityType);
}

export function auditGroupOf(entityType: string): Exclude<AuditGroup, 'all'> {
  if (MODEL_TYPES.has(entityType)) {
    return 'models';
  }
  return INTEGRATION_TYPES.has(entityType) ? 'integrations' : 'settings';
}

export const AUDIT_GROUP_OPTIONS: { label: string; value: AuditGroup }[] = [
  { label: 'All changes', value: 'all' },
  { label: 'Models, agents and skills', value: 'models' },
  { label: 'Integrations and connections', value: 'integrations' },
  { label: 'Settings and policy', value: 'settings' },
];

const DELTA_FIELDS = ['modelSpec', 'apiBase', 'lastFour', 'credentialId'];

/** One line saying what a change touched: the recorded field names, else the visible deltas. */
export function summarizeAuditChange(before: unknown, after: unknown): string {
  const a = (after ?? {}) as Record<string, unknown>;
  const b = (before ?? {}) as Record<string, unknown>;
  if (Array.isArray(a.changedFields) && a.changedFields.length > 0) {
    return (a.changedFields as string[]).join(', ');
  }
  const deltas = DELTA_FIELDS.filter((f) => f in a || f in b)
    .filter((f) => JSON.stringify(b[f] ?? null) !== JSON.stringify(a[f] ?? null))
    .map((f) => `${f}: ${JSON.stringify(b[f] ?? null)} → ${JSON.stringify(a[f] ?? null)}`);
  return deltas.length ? deltas.join('; ') : '—';
}
