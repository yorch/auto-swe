import { type ConnectionType, decryptConnectionApiToken } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { ApplicationFailure } from '@temporalio/activity';

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
    case 'http_api':
    case 'hubspot':
    case 'mcp':
    case 'notion':
    case 'slack_workspace':
    case 'zendesk':
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
    case 'http_api':
    case 'hubspot':
    case 'mcp':
    case 'notion':
    case 'slack_workspace':
    case 'zendesk':
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
    case 'http_api':
    case 'hubspot':
    case 'mcp':
    case 'notion':
    case 'slack_workspace':
    case 'zendesk':
      return genericRunTool(connection.type, connection, token);
    default:
      throw ApplicationFailure.nonRetryable(
        `Unsupported connection type for runTool: ${connection.type}`
      );
  }
}
