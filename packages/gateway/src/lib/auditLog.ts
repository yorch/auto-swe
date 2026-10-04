import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';

export type AuditEntityType =
  | 'Agent'
  | 'AutonomyPolicy'
  | 'Bundle'
  | 'ConfigPermission'
  | 'Connection'
  | 'ConnectionCredential'
  | 'EmbeddingConfig'
  | 'EvalDataset'
  | 'EvalRubric'
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
  | 'PersonalAccessToken'
  | 'ProviderCredential'
  | 'ScannerPattern'
  | 'ScheduledWorkRequest'
  | 'Session'
  | 'Skill'
  | 'SlackChannel'
  | 'SlackConfig'
  | 'StorageConfig'
  | 'User'
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
  }
): Promise<void> {
  await fastify.prisma.configAuditLog.create({
    data: {
      action: args.action,
      actorId: args.actor?.sub ?? null,
      afterJson: (args.after ?? null) as never,
      beforeJson: (args.before ?? null) as never,
      entityId: args.entityId,
      entityType: args.entityType,
    },
  });
}
