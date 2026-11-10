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
 * connection is reachable from these steps (through the same governed core as the `mcp` node),
 * as well as from the `mcp` node itself.
 */
export const GENERIC_STEP_CONNECTION_TYPES: Record<
  GenericConnectionStep,
  readonly ConnectionType[]
> = {
  readSource: ['notion', 'zendesk', 'issue_tracker', 'confluence', 'http_api', 'hubspot', 'mcp'],
  runTool: [
    'zendesk',
    'slack_workspace',
    'issue_tracker',
    'confluence',
    'http_api',
    'hubspot',
    'mcp',
    'notion',
  ],
  writeOutcome: [
    'notion',
    'zendesk',
    'slack_workspace',
    'issue_tracker',
    'confluence',
    'http_api',
    'hubspot',
    'mcp',
  ],
};

/** The non-retryable failure type the worker raises for a step with no implementation. */
export const CONNECTOR_NOT_IMPLEMENTED = 'CONNECTOR_NOT_IMPLEMENTED';

/** Why `step` cannot act on a `type` connection, or null when it can. */
export function genericStepRefusal(step: GenericConnectionStep, type: string): string | null {
  if ((GENERIC_STEP_CONNECTION_TYPES[step] as readonly string[]).includes(type)) {
    return null;
  }
  const where =
    type === 'git_repo' ? ' Repository work runs through the engineering activities.' : '';
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

/** Most `defaultHeaders` a generic HTTP API connection may carry. */
export const MAX_HTTP_API_DEFAULT_HEADERS = 20;
/** Longest header value the generic HTTP API connector will send. */
export const MAX_HTTP_API_HEADER_VALUE_LENGTH = 2048;

/** An RFC 9110 `token`: the only characters a header name may contain. */
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** Visible ASCII plus space and tab: no CR, LF or other control character. */
const HTTP_HEADER_VALUE_RE = /^[\t\x20-\x7e]*$/;

/**
 * Header names a generic HTTP API connection may not set — in `defaultHeaders`, in a step's
 * per-request headers, or as `authHeaderName`. They either carry a credential (the connection's
 * own `authType` is the one sanctioned way to send one), or change how the message is framed or
 * who it is addressed to.
 */
const FORBIDDEN_HTTP_API_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Headers some servers read to rewrite the path or the method after the request is built.
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
  'x-original-url',
  'x-real-ip',
  'x-rewrite-url',
]);

/** Longest `baseUrl` accepted. */
export const MAX_HTTP_API_BASE_URL_LENGTH = 2048;

export function isHttpHeaderName(name: string): boolean {
  return HTTP_HEADER_NAME_RE.test(name);
}

export function isHttpHeaderValue(value: string): boolean {
  return value.length <= MAX_HTTP_API_HEADER_VALUE_LENGTH && HTTP_HEADER_VALUE_RE.test(value);
}

/** Whether a header name is one a generic HTTP API connection refuses to let anyone set. */
export function isForbiddenHttpApiHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    FORBIDDEN_HTTP_API_HEADERS.has(lower) ||
    lower.startsWith('proxy-') ||
    lower.startsWith('x-forwarded-')
  );
}

/** Why a base URL cannot be the prefix of a credentialed API, or null when it can. */
function httpApiBaseUrlProblem(value: string): string | null {
  if (value.length > MAX_HTTP_API_BASE_URL_LENGTH) {
    return `baseUrl must be at most ${MAX_HTTP_API_BASE_URL_LENGTH} characters`;
  }
  // Checked on the raw string: the URL parser strips tabs and newlines, so `/.\t./` would
  // otherwise become a `..` segment after the segment check below has looked at it.
  if ([...value].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f)) {
    return 'baseUrl must not contain whitespace or control characters';
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'baseUrl must be an absolute URL';
  }
  if (url.protocol !== 'https:') {
    return 'baseUrl must use https';
  }
  if (url.username || url.password) {
    return 'baseUrl must not contain credentials';
  }
  if (value.includes('?') || value.includes('#')) {
    return 'baseUrl must not contain a query or fragment';
  }
  // Checked on the raw string: `new URL` normalises `/v1/%2e%2e/` before a check on `pathname`
  // could see it.
  if (value.includes('\\') || /%(?:2e|2f|5c|00|25)/i.test(value)) {
    return 'baseUrl must not contain backslashes or encoded dots, slashes or percent signs';
  }
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) {
    return 'baseUrl must not contain "." or ".." segments';
  }
  if (url.port === '0') {
    return 'baseUrl must not use port 0';
  }
  return null;
}

/**
 * Generic HTTP API config stored in `Connection.config`.
 *
 * `baseUrl` is the origin plus an optional path prefix every request is confined to. It is
 * https-only and there is **no private-network opt-in**: the row is editable by a team LEAD,
 * and the connector sends the connection's token to it, so a self-service opt-in would be no
 * guard at all (see {@link ConfluenceConnectionConfigSchema}). The token's destination is the
 * origin of `baseUrl` (`credentialDestination.ts`), so moving it with a token stored is refused.
 *
 * Strict (unknown keys fail) so a misspelt `authType` is an error and not a silent `bearer`.
 */
export const HttpApiConnectionConfigSchema = z
  .object({
    /** The header carrying the token when `authType` is `header`, e.g. `X-Api-Key`. */
    authHeaderName: z.string().optional(),
    /** How the stored API token is presented. Defaults to `bearer`. */
    authType: z.enum(['bearer', 'header', 'basic', 'none']).optional(),
    baseUrl: z.string().superRefine((value, ctx) => {
      const problem = httpApiBaseUrlProblem(value);
      if (problem) {
        ctx.addIssue({ code: 'custom', message: problem });
      }
    }),
    /** The user name for `basic`; the stored API token is the password. */
    basicUsername: z.string().min(1).max(256).optional(),
    /** Static, non-credential headers sent on every request. */
    defaultHeaders: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const authType = config.authType ?? 'bearer';
    const authHeader = config.authHeaderName?.toLowerCase();
    if (config.authHeaderName !== undefined) {
      if (!isHttpHeaderName(config.authHeaderName)) {
        ctx.addIssue({
          code: 'custom',
          message: 'authHeaderName is not a valid header name',
          path: ['authHeaderName'],
        });
      } else if (isForbiddenHttpApiHeader(config.authHeaderName)) {
        ctx.addIssue({
          code: 'custom',
          message: `authHeaderName may not be ${config.authHeaderName}`,
          path: ['authHeaderName'],
        });
      }
    }
    if (authType === 'header' && !config.authHeaderName) {
      ctx.addIssue({
        code: 'custom',
        message: 'authHeaderName is required when authType is header',
        path: ['authHeaderName'],
      });
    }
    if (authType !== 'header' && config.authHeaderName !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'authHeaderName applies only when authType is header',
        path: ['authHeaderName'],
      });
    }
    if (authType !== 'basic' && config.basicUsername !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'basicUsername applies only when authType is basic',
        path: ['basicUsername'],
      });
    }
    if (config.basicUsername?.includes(':')) {
      ctx.addIssue({
        code: 'custom',
        message: 'basicUsername must not contain a colon',
        path: ['basicUsername'],
      });
    }
    const entries = Object.entries(config.defaultHeaders ?? {});
    if (entries.length > MAX_HTTP_API_DEFAULT_HEADERS) {
      ctx.addIssue({
        code: 'custom',
        message: `defaultHeaders may hold at most ${MAX_HTTP_API_DEFAULT_HEADERS} headers`,
        path: ['defaultHeaders'],
      });
    }
    const seen = new Set<string>();
    for (const [name, value] of entries) {
      const lower = name.toLowerCase();
      const path = ['defaultHeaders', name];
      if (!isHttpHeaderName(name)) {
        ctx.addIssue({ code: 'custom', message: `${name} is not a valid header name`, path });
      } else if (isForbiddenHttpApiHeader(name) || lower === authHeader) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} may not be a default header: credentials go in the connection's API token`,
          path,
        });
      } else if (seen.has(lower)) {
        ctx.addIssue({ code: 'custom', message: `${name} is listed twice`, path });
      }
      seen.add(lower);
      if (!isHttpHeaderValue(value)) {
        ctx.addIssue({ code: 'custom', message: `the value of ${name} is not valid`, path });
      }
    }
  });

export type HttpApiConnectionConfig = z.infer<typeof HttpApiConnectionConfigSchema>;

export type HttpApiConnectionConfigResult =
  | { ok: true; config: HttpApiConnectionConfig }
  | { ok: false; reason: string };

/**
 * Parse a stored `http_api` config for use.
 *
 * Unlike the other `parseXConnectionConfig` helpers, this does **not** fall back to `{}`: an
 * empty config here would be a connector with no destination, and a fallback that "works"
 * would hide the refusal the worker has to make. It returns a result the caller must look at;
 * the reason names the offending fields, never their values.
 */
export function parseHttpApiConnectionConfig(config: unknown): HttpApiConnectionConfigResult {
  const parsed = HttpApiConnectionConfigSchema.safeParse(config ?? {});
  if (parsed.success) {
    return { config: parsed.data, ok: true };
  }
  const reason = parsed.error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${where}${issue.message}`;
    })
    .join('; ');
  return { ok: false, reason };
}
