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
  | 'GitHubConfig'
  | 'GitHubHostCredential'
  | 'GitHubHostWebhookSecret'
  | 'GitHubInstallation'
  | 'GoogleOAuthConfig'
  | 'McpGrant'
  | 'McpToolCall'
  | 'MemoryItem'
  | 'ModelCatalogEntry'
  | 'ModelSuggestion'
  | 'OktaOAuthConfig'
  | 'Organization'
  | 'OrganizationMembership'
  | 'OutboundDelivery'
  | 'PackageRegistry'
  | 'PersonalAccessToken'
  | 'ProviderCredential'
  | 'ReportDigestSubscription'
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
  | 'TeamMembership'
  | 'User'
  | 'WorkflowTemplate'
  | 'WorkRequest'
  | 'WorkflowRun';

export async function writeAuditLog(
  fastify: FastifyInstance,
  args: {
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
  }
): Promise<void> {
  await (args.client ?? fastify.prisma).configAuditLog.create({
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
}
