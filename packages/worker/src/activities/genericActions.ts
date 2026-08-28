import {
  type ConnectionType,
  decryptConnectionApiToken,
  parseNotionConnectionConfig,
  parseZendeskConnectionConfig,
} from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { ApplicationFailure } from '@temporalio/activity';
import {
  appendNotionBlocks,
  createNotionPage,
  type NotionBlock,
  readNotionPage,
} from '../connectors/notion.js';
import { fetchZendeskTicket, postZendeskComment } from '../connectors/zendesk.js';

/**
 * Generic read/write/tool activities parameterised by connection type.
 *
 * These are the foundation for non-SWE templates. Each handler is responsible
 * for loading its Connection, decrypting the API token, and producing a
 * structured result. For Phase 1 the non-git handlers are placeholders that
 * validate the connection and surface its metadata; concrete API calls land in
 * the domain-specific activity packs.
 */

export interface ReadSourceInput {
  connectionId: string;
  query?: unknown;
}

export interface ReadSourceResult {
  connectionType: ConnectionType;
  data?: unknown;
  ok: boolean;
  placeholder?: boolean;
}

export interface WriteOutcomeInput {
  connectionId: string;
  data: unknown;
}

export interface WriteOutcomeResult {
  connectionType: ConnectionType;
  ok: boolean;
  placeholder?: boolean;
  reference?: string;
}

export interface RunToolInput {
  connectionId: string;
  inputs?: unknown;
  tool: string;
}

export interface RunToolResult {
  connectionType: ConnectionType;
  ok: boolean;
  output?: unknown;
  placeholder?: boolean;
}

async function loadConnection(connectionId: string) {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
  });
  if (!connection?.isActive) {
    throw ApplicationFailure.nonRetryable(`Connection ${connectionId} not found or inactive`);
  }
  return connection;
}

function getApiToken(connection: {
  apiKeyAuthTag: Buffer | Uint8Array | null;
  apiKeyCiphertext: Buffer | Uint8Array | null;
  apiKeyNonce: Buffer | Uint8Array | null;
  apiKeyVersion: number;
}): string | null {
  if (!connection.apiKeyCiphertext || !connection.apiKeyNonce || !connection.apiKeyAuthTag) {
    return null;
  }
  return decryptConnectionApiToken({
    apiKeyAuthTag: connection.apiKeyAuthTag,
    apiKeyCiphertext: connection.apiKeyCiphertext,
    apiKeyNonce: connection.apiKeyNonce,
    apiKeyVersion: connection.apiKeyVersion,
  });
}

async function gitRepoReadSource(_connection: unknown, query: unknown): Promise<ReadSourceResult> {
  const q = typeof query === 'object' && query != null ? query : {};
  return {
    connectionType: 'git_repo',
    data: {
      hint: 'Use the SWE activities (executeImplementation, shellStep) for git_repo work',
      query: q,
    },
    ok: true,
    placeholder: true,
  };
}

function requireToken(token: string | null): string {
  if (!token) {
    throw ApplicationFailure.nonRetryable('Connection API token is required');
  }
  return token;
}

async function notionReadSource(
  connection: { config: unknown },
  token: string | null,
  query: unknown
): Promise<ReadSourceResult> {
  const config = parseNotionConnectionConfig(connection.config);
  const requestedPageId =
    (typeof query === 'object' && query != null && (query as Record<string, unknown>).pageId) ||
    config.sourcePageId;
  if (typeof requestedPageId !== 'string') {
    throw ApplicationFailure.nonRetryable(
      'Notion readSource requires a pageId in query or connection config'
    );
  }
  const content = await readNotionPage({ apiToken: requireToken(token) }, requestedPageId);
  return { connectionType: 'notion', data: content, ok: true };
}

async function zendeskReadSource(
  connection: { config: unknown },
  token: string | null,
  query: unknown
): Promise<ReadSourceResult> {
  const requestedTicketId =
    typeof query === 'object' && query != null
      ? (query as Record<string, unknown>).ticketId
      : undefined;
  if (typeof requestedTicketId !== 'string') {
    throw ApplicationFailure.nonRetryable('Zendesk readSource requires a ticketId in query');
  }
  const result = await fetchZendeskTicket(
    { apiToken: requireToken(token), config: parseZendeskConnectionConfig(connection.config) },
    requestedTicketId
  );
  return { connectionType: 'zendesk', data: result, ok: true };
}

async function genericReadSource(
  connectionType: ConnectionType,
  _connection: unknown,
  _token: string | null
): Promise<ReadSourceResult> {
  return {
    connectionType,
    ok: true,
    placeholder: true,
  };
}

/**
 * Read a source object from the target connection. For `git_repo` this returns
 * a pointer that the SWE path already covers; for other types it is a
 * placeholder awaiting the domain-specific activity pack.
 */
export async function readSource(input: ReadSourceInput): Promise<ReadSourceResult> {
  const connection = await loadConnection(input.connectionId);
  const token = getApiToken(connection);
  switch (connection.type) {
    case 'git_repo':
      return gitRepoReadSource(connection, input.query);
    case 'notion':
      return notionReadSource(connection, token, input.query);
    case 'zendesk':
      return zendeskReadSource(connection, token, input.query);
    case 'http_api':
    case 'hubspot':
    case 'mcp':
    case 'slack_workspace':
      return genericReadSource(connection.type, connection, token);
    default:
      throw ApplicationFailure.nonRetryable(
        `Unsupported connection type for readSource: ${connection.type}`
      );
  }
}

async function gitRepoWriteOutcome(
  _connection: unknown,
  _data: unknown
): Promise<WriteOutcomeResult> {
  return {
    connectionType: 'git_repo',
    ok: true,
    placeholder: true,
    reference: 'Use createOrUpdatePullRequest for git_repo outcomes',
  };
}

async function notionWriteOutcome(
  connection: { config: unknown },
  token: string | null,
  data: unknown
): Promise<WriteOutcomeResult> {
  const config = parseNotionConnectionConfig(connection.config);
  if (typeof data !== 'object' || data == null) {
    throw ApplicationFailure.nonRetryable('Notion writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const apiToken = requireToken(token);

  // Append blocks to an existing page.
  if (Array.isArray(d.blocks)) {
    const pageId = (d.pageId as string | undefined) ?? config.sourcePageId;
    if (!pageId) {
      throw ApplicationFailure.nonRetryable(
        'Notion writeOutcome blocks requires pageId or a default sourcePageId on the connection'
      );
    }
    const result = await appendNotionBlocks({ apiToken }, pageId, d.blocks as NotionBlock[]);
    return {
      connectionType: 'notion',
      ok: true,
      reference: result.pageId,
    };
  }

  if (!isCreatePageData(d)) {
    throw ApplicationFailure.nonRetryable(
      'Notion writeOutcome data must include blocks or a create-page request'
    );
  }

  // Create a new page.
  const created = await createNotionPage(
    { apiToken },
    {
      databaseId: d.databaseId as string | undefined,
      pageId: (d.pageId as string | undefined) ?? config.sourcePageId,
      properties: (d.properties as Record<string, unknown> | undefined) ?? {},
      title: d.title as string | undefined,
    }
  );
  return { connectionType: 'notion', ok: true, reference: created.url };
}

async function zendeskWriteOutcome(
  connection: { config: unknown },
  token: string | null,
  data: unknown
): Promise<WriteOutcomeResult> {
  if (typeof data !== 'object' || data == null) {
    throw ApplicationFailure.nonRetryable('Zendesk writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const ticketId = d.ticketId;
  const body = d.body;
  if (typeof ticketId !== 'string' || typeof body !== 'string') {
    throw ApplicationFailure.nonRetryable(
      'Zendesk writeOutcome requires ticketId and body strings'
    );
  }
  const isPublic = d.public === true;
  const result = await postZendeskComment(
    { apiToken: requireToken(token), config: parseZendeskConnectionConfig(connection.config) },
    ticketId,
    { body, public: isPublic }
  );
  return { connectionType: 'zendesk', ok: true, reference: result.ticketId };
}

function isCreatePageData(d: Record<string, unknown>): boolean {
  return (
    typeof d.databaseId === 'string' ||
    typeof d.pageId === 'string' ||
    typeof d.title === 'string' ||
    typeof d.properties === 'object'
  );
}

async function genericWriteOutcome(
  connectionType: ConnectionType,
  _connection: unknown,
  _token: string | null
): Promise<WriteOutcomeResult> {
  return { connectionType, ok: true, placeholder: true };
}

/**
 * Write a validated outcome to the target connection. Placeholder for non-git
 * types pending the domain-specific activity packs.
 */
export async function writeOutcome(input: WriteOutcomeInput): Promise<WriteOutcomeResult> {
  const connection = await loadConnection(input.connectionId);
  const token = getApiToken(connection);
  switch (connection.type) {
    case 'git_repo':
      return gitRepoWriteOutcome(connection, input.data);
    case 'notion':
      return notionWriteOutcome(connection, token, input.data);
    case 'zendesk':
      return zendeskWriteOutcome(connection, token, input.data);
    case 'http_api':
    case 'hubspot':
    case 'mcp':
    case 'slack_workspace':
      return genericWriteOutcome(connection.type, connection, token);
    default:
      throw ApplicationFailure.nonRetryable(
        `Unsupported connection type for writeOutcome: ${connection.type}`
      );
  }
}

async function gitRepoRunTool(
  _connection: unknown,
  tool: string,
  _inputs: unknown
): Promise<RunToolResult> {
  return {
    connectionType: 'git_repo',
    ok: true,
    output: { hint: `git_repo tool ${tool} is handled by the SWE activity set` },
    placeholder: true,
  };
}

async function zendeskRunTool(
  connection: { config: unknown },
  token: string | null,
  tool: string,
  inputs: unknown
): Promise<RunToolResult> {
  const apiToken = requireToken(token);
  const config = parseZendeskConnectionConfig(connection.config);
  if (tool === 'fetchTicket') {
    const ticketId =
      typeof inputs === 'object' && inputs != null
        ? (inputs as Record<string, unknown>).ticketId
        : undefined;
    if (typeof ticketId !== 'string') {
      throw ApplicationFailure.nonRetryable('fetchTicket requires a string ticketId input');
    }
    const result = await fetchZendeskTicket({ apiToken, config }, ticketId);
    return { connectionType: 'zendesk', ok: true, output: result };
  }
  if (tool === 'postComment') {
    const data = typeof inputs === 'object' && inputs != null ? inputs : {};
    const ticketId = (data as Record<string, unknown>).ticketId;
    const body = (data as Record<string, unknown>).body;
    if (typeof ticketId !== 'string' || typeof body !== 'string') {
      throw ApplicationFailure.nonRetryable('postComment requires string ticketId and body inputs');
    }
    const isPublic = (data as Record<string, unknown>).public === true;
    const result = await postZendeskComment({ apiToken, config }, ticketId, {
      body,
      public: isPublic,
    });
    return { connectionType: 'zendesk', ok: true, output: result };
  }
  throw ApplicationFailure.nonRetryable(`Unsupported Zendesk tool: ${tool}`);
}

async function genericRunTool(
  connectionType: ConnectionType,
  _connection: unknown,
  _token: string | null
): Promise<RunToolResult> {
  return { connectionType, ok: true, placeholder: true };
}

/**
 * Run an arbitrary tool against the target connection. Placeholder for non-git
 * types pending the domain-specific activity packs.
 */
export async function runTool(input: RunToolInput): Promise<RunToolResult> {
  const connection = await loadConnection(input.connectionId);
  const token = getApiToken(connection);
  switch (connection.type) {
    case 'git_repo':
      return gitRepoRunTool(connection, input.tool, input.inputs);
    case 'zendesk':
      return zendeskRunTool(connection, token, input.tool, input.inputs);
    case 'http_api':
    case 'hubspot':
    case 'mcp':
    case 'notion':
    case 'slack_workspace':
      return genericRunTool(connection.type, connection, token);
    default:
      throw ApplicationFailure.nonRetryable(
        `Unsupported connection type for runTool: ${connection.type}`
      );
  }
}
