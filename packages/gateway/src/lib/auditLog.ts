import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import { type AuditContext, auditContextData } from './auditContext.js';

export type AuditEntityType =
  | 'ActiveWorkflow'
  | 'Agent'
  | 'AssistantAction'
  | 'Automation'
  | 'AutonomyPolicy'
  | 'Bundle'
  | 'Campaign'
  | 'CallbackEndpoint'
  | 'ConfigPermission'
  | 'Connection'
  | 'ConnectionCredential'
  | 'EmbeddingConfig'
  | 'EvalCase'
  | 'EvalDataset'
  | 'EvalRun'
  | 'EvalRubric'
  | 'EventEndpoint'
  | 'FailureAssignment'
  | 'GitHubApproverApp'
  | 'GitHubConfig'
  | 'GitHubHostCredential'
  | 'GitHubHostWebhookSecret'
  | 'GitHubInstallation'
  | 'GoogleOAuthConfig'
  | 'HarnessProfile'
  | 'MarketplaceSource'
  | 'McpGrant'
  | 'McpToolCall'
  | 'MemoryItem'
  | 'KnowledgeBase'
  | 'KnowledgeBaseLink'
  | 'ModelCatalogEntry'
  | 'ModelSuggestion'
  | 'OktaOAuthConfig'
  | 'Organization'
  | 'OrganizationMembership'
  | 'Orchestration'
  | 'OutboundDelivery'
  | 'PackageRegistry'
  | 'PersonalAccessToken'
  | 'PluginEnablement'
  | 'ProviderCredential'
  | 'PullRequestReview'
  | 'ReportDigestSubscription'
  | 'ReviewPreset'
  | 'ReviewPresetAttachment'
  | 'RunPlan'
  | 'ScannerPattern'
  | 'ScheduledWorkRequest'
  | 'ServicePrincipal'
  | 'ServiceToken'
  | 'Session'
  | 'Skill'
  | 'SkillSource'
  | 'SlackChannel'
  | 'SlackConfig'
  | 'StorageConfig'
  | 'Team'
  | 'TeamBudgetRequest'
  | 'TeamJoinRequest'
  | 'TeamMembership'
  | 'TeamSecret'
  | 'ToolCatalogEntry'
  | 'User'
  | 'WorkflowHumanStep'
  | 'WorkflowShellAudit'
  | 'WorkflowTemplate'
  | 'WorkRequest'
  | 'WorkflowRun';

type AuditArgs = {
  action: 'CREATE' | 'DELETE' | 'UPDATE';
  /** Null when the system acts — a webhook or a sweep, not a person. */
  actor: JwtPayload | null;
  after?: unknown;
  before?: unknown;
  entityId: string;
  entityType: AuditEntityType;
  /** Overrides the request's audit context; by default it is read from the request being handled. */
  context?: AuditContext;
  /** A transaction client, so the entry commits or rolls back with the change it records. */
  client?: Pick<FastifyInstance['prisma'], 'configAuditLog'>;
};

export async function writeAuditLog(fastify: FastifyInstance, args: AuditArgs): Promise<void> {
  await writeAuditLogRow(fastify, args);
}

/** {@link writeAuditLog}, returning the id of the row written, for a caller that may delete it. */
export async function writeAuditLogRow(
  fastify: FastifyInstance,
  args: AuditArgs
): Promise<string | undefined> {
  const row = await (args.client ?? fastify.prisma).configAuditLog.create({
    data: {
      action: args.action,
      actorId: args.actor?.sub ?? null,
      afterJson: (args.after ?? null) as never,
      beforeJson: (args.before ?? null) as never,
      entityId: args.entityId,
      entityType: args.entityType,
      ...auditContextData(args.context),
    },
  });
  // The id of the row written, for a caller that must later delete exactly this row.
  return (row as { id?: string } | undefined)?.id;
}
