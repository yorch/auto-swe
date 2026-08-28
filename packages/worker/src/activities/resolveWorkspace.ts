import { decryptConnectionApiToken, parseNotionConnectionConfig } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import type { WorkspaceProviderType } from '@auto-swe/shared/lib/workspaceProviders';
import { ApplicationFailure } from '@temporalio/activity';
import { readNotionPage } from '../connectors/notion.js';

/**
 * Generic workspace context materialised before a run's work stage.
 *
 * For `git_repo` this is the repository identity the existing SWE path already
 * consumes. For `document`/`record` it carries the external resource locator
 * from the Connection config. For `api_only` it is intentionally empty — the
 * run operates purely through APIs and returns a structured result.
 */
export type WorkspaceContext =
  | { provider: 'api_only' }
  | {
      branch: string;
      cloneUrl: string;
      connectionId: string;
      defaultBranch: string;
      provider: 'git_repo';
      repoName: string;
      repoOwner: string;
    }
  | {
      connectionId: string;
      provider: 'document';
      sourceId?: string;
      workspaceName?: string;
    }
  | {
      connectionId: string;
      provider: 'record';
      recordId?: string;
      recordType?: string;
      workspaceName?: string;
    };

export interface ResolveWorkspaceInput {
  workspaceProvider: WorkspaceProviderType;
  connectionId?: string | null;
  payload?: unknown;
}

async function resolveGitRepoWorkspace(connectionId: string): Promise<WorkspaceContext> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
  });
  if (!connection?.isActive || connection.type !== 'git_repo') {
    throw ApplicationFailure.nonRetryable(
      `Connection ${connectionId} is not an active git_repo connection`
    );
  }
  if (!connection.organizationName || !connection.repoName) {
    throw ApplicationFailure.nonRetryable(
      `git_repo connection ${connectionId} is missing owner/name`
    );
  }
  return {
    branch: connection.defaultBranch,
    cloneUrl:
      connection.githubUrl ??
      `https://github.com/${connection.organizationName}/${connection.repoName}.git`,
    connectionId,
    defaultBranch: connection.defaultBranch,
    provider: 'git_repo',
    repoName: connection.repoName,
    repoOwner: connection.organizationName,
  };
}

async function resolveDocumentWorkspace(
  connectionId: string,
  payload?: unknown
): Promise<WorkspaceContext> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
  });
  if (!connection?.isActive || connection.type !== 'notion') {
    throw ApplicationFailure.nonRetryable(
      `Connection ${connectionId} is not an active notion connection`
    );
  }
  const config = parseNotionConnectionConfig(connection.config);
  const payloadPageId =
    typeof payload === 'object' && payload != null
      ? (payload as Record<string, unknown>).pageId
      : undefined;
  const sourceId =
    (typeof payloadPageId === 'string' ? payloadPageId : config.sourcePageId) ?? null;

  if (
    sourceId &&
    connection.apiKeyCiphertext &&
    connection.apiKeyNonce &&
    connection.apiKeyAuthTag
  ) {
    const apiToken = decryptConnectionApiToken({
      apiKeyAuthTag: connection.apiKeyAuthTag,
      apiKeyCiphertext: connection.apiKeyCiphertext,
      apiKeyNonce: connection.apiKeyNonce,
      apiKeyVersion: connection.apiKeyVersion,
    });
    // Validate reachability early; the activity will fail fast if the page is missing.
    await readNotionPage({ apiToken }, sourceId);
  }

  return {
    connectionId,
    provider: 'document',
    sourceId: sourceId ?? undefined,
    workspaceName: connection.name ?? undefined,
  };
}

async function resolveRecordWorkspace(connectionId: string): Promise<WorkspaceContext> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
  });
  if (!connection?.isActive || (connection.type !== 'zendesk' && connection.type !== 'hubspot')) {
    throw ApplicationFailure.nonRetryable(
      `Connection ${connectionId} is not an active zendesk or hubspot connection`
    );
  }
  const config = (connection.config as Record<string, unknown> | undefined) ?? {};
  return {
    connectionId,
    provider: 'record',
    recordId: typeof config.recordId === 'string' ? config.recordId : undefined,
    recordType: typeof config.recordType === 'string' ? config.recordType : undefined,
    workspaceName: connection.name ?? undefined,
  };
}

function resolveApiOnlyWorkspace(): WorkspaceContext {
  return { provider: 'api_only' };
}

/**
 * Materialise the workspace context for a run based on its declared workspace
 * provider and target connection.
 */
export async function resolveWorkspace(input: ResolveWorkspaceInput): Promise<WorkspaceContext> {
  switch (input.workspaceProvider) {
    case 'api_only':
      return resolveApiOnlyWorkspace();
    case 'document': {
      if (!input.connectionId) {
        throw ApplicationFailure.nonRetryable('document workspace requires a connectionId');
      }
      return resolveDocumentWorkspace(input.connectionId, input.payload);
    }
    case 'git_repo': {
      if (!input.connectionId) {
        throw ApplicationFailure.nonRetryable('git_repo workspace requires a connectionId');
      }
      return resolveGitRepoWorkspace(input.connectionId);
    }
    case 'record': {
      if (!input.connectionId) {
        throw ApplicationFailure.nonRetryable('record workspace requires a connectionId');
      }
      return resolveRecordWorkspace(input.connectionId);
    }
    default:
      throw ApplicationFailure.nonRetryable(
        `Unknown workspace provider: ${(input as ResolveWorkspaceInput).workspaceProvider}`
      );
  }
}
