import { z } from 'zod';

/**
 * Runtime registry of supported connection types.
 *
 * The discriminator lives in `Connection.type` as a plain string so new
 * connectors can be added without a schema migration. This module provides
 * the typed union, metadata, and validation helpers that gateway and worker
 * code use to reason about connections consistently.
 */

export const CONNECTION_TYPES = [
  'git_repo',
  'issue_tracker',
  'notion',
  'zendesk',
  'hubspot',
  'slack_workspace',
  'http_api',
  'mcp',
] as const;

export type ConnectionType = (typeof CONNECTION_TYPES)[number];

export interface ConnectionTypeMetadata {
  key: ConnectionType;
  label: string;
  description: string;
  /** Whether the connection can be the target workspace of a workflow run. */
  isWorkspaceTarget: boolean;
  /** Whether the connection stores type-specific configuration in `Connection.config`. */
  supportsConfig: boolean;
}

const METADATA: Record<ConnectionType, ConnectionTypeMetadata> = {
  git_repo: {
    description: 'A git repository hosted on GitHub or another Git provider.',
    isWorkspaceTarget: true,
    key: 'git_repo',
    label: 'Git repository',
    supportsConfig: false,
  },
  http_api: {
    description: 'Generic HTTP API endpoint with configurable headers and auth.',
    isWorkspaceTarget: false,
    key: 'http_api',
    label: 'HTTP API',
    supportsConfig: true,
  },
  hubspot: {
    description: 'HubSpot CRM for contact, ticket, and object operations.',
    isWorkspaceTarget: true,
    key: 'hubspot',
    label: 'HubSpot',
    supportsConfig: true,
  },
  issue_tracker: {
    description: 'Linear or Jira issue tracker for fetching and creating issues.',
    isWorkspaceTarget: true,
    key: 'issue_tracker',
    label: 'Issue tracker',
    supportsConfig: true,
  },
  mcp: {
    description: 'Model Context Protocol server exposing tools to agents.',
    isWorkspaceTarget: false,
    key: 'mcp',
    label: 'MCP server',
    supportsConfig: true,
  },
  notion: {
    description: 'Notion workspace connection for reading and writing pages and databases.',
    isWorkspaceTarget: true,
    key: 'notion',
    label: 'Notion',
    supportsConfig: true,
  },
  slack_workspace: {
    description: 'Slack workspace-level connection for posting messages and reading channels.',
    isWorkspaceTarget: false,
    key: 'slack_workspace',
    label: 'Slack workspace',
    supportsConfig: true,
  },
  zendesk: {
    description: 'Zendesk Support instance for ticket and comment operations.',
    isWorkspaceTarget: true,
    key: 'zendesk',
    label: 'Zendesk',
    supportsConfig: true,
  },
};

export const ConnectionTypeSchema = z.enum(CONNECTION_TYPES);

export function isConnectionType(value: unknown): value is ConnectionType {
  return typeof value === 'string' && (CONNECTION_TYPES as readonly string[]).includes(value);
}

export function getConnectionTypeMetadata(type: ConnectionType): ConnectionTypeMetadata {
  return METADATA[type];
}

export function listConnectionTypes(): ConnectionTypeMetadata[] {
  return CONNECTION_TYPES.map((key) => METADATA[key]);
}

export function getWorkspaceTargetTypes(): ConnectionType[] {
  return CONNECTION_TYPES.filter((key) => METADATA[key].isWorkspaceTarget);
}

export function isWorkspaceTargetType(type: ConnectionType): boolean {
  return METADATA[type]?.isWorkspaceTarget ?? false;
}

/**
 * Notion-specific config stored in `Connection.config`.
 *
 * `sourcePageId` is optional: runs may pass a page/page_id in the payload, or a
 * team may set a default page on the connection.
 */
export const NotionConnectionConfigSchema = z.object({
  sourcePageId: z.string().optional(),
});

export type NotionConnectionConfig = z.infer<typeof NotionConnectionConfigSchema>;

export function parseNotionConnectionConfig(config: unknown): NotionConnectionConfig {
  const parsed = NotionConnectionConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : {};
}

export const ZendeskConnectionConfigSchema = z.object({
  email: z.string().email().optional(),
  subdomain: z.string().min(1).optional(),
});

export type ZendeskConnectionConfig = z.infer<typeof ZendeskConnectionConfigSchema>;

export function parseZendeskConnectionConfig(config: unknown): ZendeskConnectionConfig {
  const parsed = ZendeskConnectionConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : {};
}

export const SlackConnectionConfigSchema = z.object({
  defaultChannelId: z.string().optional(),
});

export type SlackConnectionConfig = z.infer<typeof SlackConnectionConfigSchema>;

export function parseSlackConnectionConfig(config: unknown): SlackConnectionConfig {
  const parsed = SlackConnectionConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : {};
}

export const IssueTrackerConnectionConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  defaultProjectKey: z.string().min(1).optional(),
  email: z.string().email().optional(),
  provider: z.enum(['linear', 'jira']).optional(),
});

export type IssueTrackerConnectionConfig = z.infer<typeof IssueTrackerConnectionConfigSchema>;

export function parseIssueTrackerConnectionConfig(config: unknown): IssueTrackerConnectionConfig {
  const parsed = IssueTrackerConnectionConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : {};
}
