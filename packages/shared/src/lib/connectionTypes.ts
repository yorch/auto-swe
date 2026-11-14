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
  'confluence',
  'zendesk',
  'pagerduty',
  'pagerduty_events',
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
  confluence: {
    description: 'Confluence space for reading pages and creating or updating them.',
    isWorkspaceTarget: true,
    key: 'confluence',
    label: 'Confluence',
    supportsConfig: true,
  },
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
  pagerduty: {
    description: 'PagerDuty account for reading incidents and adding incident notes.',
    isWorkspaceTarget: false,
    key: 'pagerduty',
    label: 'PagerDuty',
    supportsConfig: true,
  },
  pagerduty_events: {
    description:
      'A PagerDuty service integration (Events API v2 routing key) that receives a change event when a pull request from an auto-swe run merges.',
    isWorkspaceTarget: false,
    key: 'pagerduty_events',
    label: 'PagerDuty change events',
    supportsConfig: false,
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

/** The generic steps that dispatch on a connection's type. */
export type GenericConnectionStep = 'readSource' | 'writeOutcome' | 'runTool';

/**
 * Which connection types each generic step can really act on. A type absent from a step's list
 * has no implementation behind that step, and the worker fails the step with
 * `CONNECTOR_NOT_IMPLEMENTED` rather than report success without acting. `git_repo` is absent
 * everywhere: repository work runs through the engineering activities, not these steps. An `mcp`
 * connection is reached by the `mcp` node, not by these steps.
 */
export const GENERIC_STEP_CONNECTION_TYPES: Record<
  GenericConnectionStep,
  readonly ConnectionType[]
> = {
  readSource: ['notion', 'zendesk', 'issue_tracker', 'confluence', 'pagerduty'],
  runTool: ['zendesk', 'slack_workspace', 'issue_tracker', 'confluence', 'pagerduty'],
  writeOutcome: [
    'notion',
    'zendesk',
    'slack_workspace',
    'issue_tracker',
    'confluence',
    'pagerduty',
  ],
};

/** The non-retryable failure type the worker raises for a step with no implementation. */
export const CONNECTOR_NOT_IMPLEMENTED = 'CONNECTOR_NOT_IMPLEMENTED';

/**
 * Connection types no step of any kind can act on: they can be stored, but nothing sends a
 * request through them. A template cannot declare one as a `connection` input.
 */
export const UNIMPLEMENTED_CONNECTION_TYPES: readonly ConnectionType[] = ['http_api', 'hubspot'];

/** Why `step` cannot act on a `type` connection, or null when it can. */
export function genericStepRefusal(step: GenericConnectionStep, type: string): string | null {
  if ((GENERIC_STEP_CONNECTION_TYPES[step] as readonly string[]).includes(type)) {
    return null;
  }
  const where =
    type === 'mcp'
      ? ' Use an `mcp` node to call an MCP server.'
      : type === 'git_repo'
        ? ' Repository work runs through the engineering activities.'
        : '';
  return `${step} has no implementation for ${type} connections, so the step is refused rather than report success without acting.${where}`;
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

/**
 * PagerDuty-specific config stored in `Connection.config`. The REST API token is the encrypted
 * `apiKey*` columns; `fromEmail` is the account user PagerDuty attributes a note to, which its API
 * requires on every write.
 */
export const PagerDutyConnectionConfigSchema = z.object({
  fromEmail: z.string().email().optional(),
});

export type PagerDutyConnectionConfig = z.infer<typeof PagerDutyConnectionConfigSchema>;

/**
 * Why a connection's type-specific config cannot be saved, or null when it can. Types without a
 * config contract accept any object.
 */
export function connectionConfigProblem(type: string, config: unknown): string | null {
  if (type === 'pagerduty' && config != null) {
    const parsed = PagerDutyConnectionConfigSchema.safeParse(config);
    if (!parsed.success) {
      return `Invalid PagerDuty config: ${parsed.error.issues
        .map((i) => `'${i.path.join('.')}' ${i.message}`)
        .join('; ')}`;
    }
  }
  return null;
}

export function parsePagerDutyConnectionConfig(config: unknown): PagerDutyConnectionConfig {
  const parsed = PagerDutyConnectionConfigSchema.safeParse(config ?? {});
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

/**
 * Confluence config stored in `Connection.config`.
 *
 * Every field is optional so a half-filled row can exist; the worker's connector
 * refuses at use with a message naming what is missing, exactly like the
 * `issue_tracker` config it sits beside.
 *
 * There is deliberately **no `allowPrivateNetwork` here**. `baseUrl` is on the
 * `Connection` row, which a team LEAD can edit, and the worker sends the
 * connection's token to it — so a self-service private-address opt-in would be
 * no guard at all. The worker's SSRF check honours the opt-in only for the exact
 * origin an ADMIN configured at /admin/integrations → Knowledge Base, the same
 * narrower rule the tracker connection follows.
 */
export const ConfluenceConnectionConfigSchema = z.object({
  /**
   * The site root, e.g. `https://acme.atlassian.net` — API paths are appended to
   * it, so a `/wiki` suffix (or any other) produces a doubled path and a 404.
   */
  baseUrl: z.string().url().optional(),
  email: z.string().email().optional(),
  /** Default parent page for a created page when the step does not name one. */
  parentPageId: z.string().min(1).optional(),
  /** Default space for a created page when the step does not name one. */
  spaceKey: z.string().min(1).optional(),
});

export type ConfluenceConnectionConfig = z.infer<typeof ConfluenceConnectionConfigSchema>;

export function parseConfluenceConnectionConfig(config: unknown): ConfluenceConnectionConfig {
  const parsed = ConfluenceConnectionConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : {};
}
