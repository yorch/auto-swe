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
  | 'Session'
  | 'Skill'
  | 'SkillSource'
  | 'SlackChannel'
  | 'SlackConfig'
  | 'StorageConfig'
  | 'User'
  | 'WorkflowRun';

export async function writeAuditLog(
  fastify: FastifyInstance,
  args: {
    action: 'CREATE' | 'DELETE' | 'UPDATE';
    actor: JwtPayload;
    after?: unknown;
    before?: unknown;
    entityId: string;
    entityType: AuditEntityType;
    /** A transaction client, so the entry commits or rolls back with the change it records. */
    client?: Pick<FastifyInstance['prisma'], 'configAuditLog'>;
  }
): Promise<void> {
  await (args.client ?? fastify.prisma).configAuditLog.create({
    data: {
      action: args.action,
      actorId: args.actor.sub,
      afterJson: (args.after ?? null) as never,
      beforeJson: (args.before ?? null) as never,
      entityId: args.entityId,
      entityType: args.entityType,
    },
  });
}
