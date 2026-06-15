import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';

export type AuditEntityType =
  | 'Agent'
  | 'AgentSkillAssignment'
  | 'AgentToolConfig'
  | 'EmbeddingConfig'
  | 'GitHubConfig'
  | 'GoogleOAuthConfig'
  | 'ModelRoleConfig'
  | 'ProviderCredential'
  | 'ScannerPattern'
  | 'Skill'
  | 'SlackConfig'
  | 'StorageConfig';

export async function writeAuditLog(
  fastify: FastifyInstance,
  args: {
    action: 'CREATE' | 'DELETE' | 'UPDATE';
    actor: JwtPayload;
    after?: unknown;
    before?: unknown;
    entityId: string;
    entityType: AuditEntityType;
  }
): Promise<void> {
  await fastify.prisma.configAuditLog.create({
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
