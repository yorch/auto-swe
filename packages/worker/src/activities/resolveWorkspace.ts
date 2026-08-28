import {
  decryptConnectionApiToken,
  parseIssueTrackerConnectionConfig,
  parseNotionConnectionConfig,
  parseZendeskConnectionConfig,
} from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import type { WorkspaceProviderType } from '@auto-swe/shared/lib/workspaceProviders';
import { ApplicationFailure } from '@temporalio/activity';
import { fetchIssue } from '../connectors/issueTracker.js';
import { readNotionPage } from '../connectors/notion.js';
import { fetchZendeskTicket } from '../connectors/zendesk.js';

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
      issueId?: string;
      provider: 'issue_tracker';
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

async function resolveRecordWorkspace(
  connectionId: string,
  payload?: unknown
): Promise<WorkspaceContext> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
  });
  if (!connection?.isActive || (connection.type !== 'zendesk' && connection.type !== 'hubspot')) {
    throw ApplicationFailure.nonRetryable(
      `Connection ${connectionId} is not an active zendesk or hubspot connection`
    );
  }
  const config = (connection.config as Record<string, unknown> | undefined) ?? {};
  const payloadRecordId =
    typeof payload === 'object' && payload != null
      ? (payload as Record<string, unknown>).ticketId
      : undefined;
  const recordId: string | null =
    (typeof payloadRecordId === 'string'
      ? payloadRecordId
      : typeof config.recordId === 'string'
        ? config.recordId
        : null) ?? null;

  if (
    recordId &&
    connection.type === 'zendesk' &&
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
    await fetchZendeskTicket(
      { apiToken, config: parseZendeskConnectionConfig(connection.config) },
      recordId
    );
  }

  return {
    connectionId,
    provider: 'record',
    recordId: recordId ?? undefined,
    recordType: typeof config.recordType === 'string' ? config.recordType : undefined,
    workspaceName: connection.name ?? undefined,
  };
}

async function resolveIssueTrackerWorkspace(
  connectionId: string,
  payload?: unknown
): Promise<WorkspaceContext> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
  });
  if (!connection?.isActive || connection.type !== 'issue_tracker') {
    throw ApplicationFailure.nonRetryable(
      `Connection ${connectionId} is not an active issue_tracker connection`
    );
  }
  const config = parseIssueTrackerConnectionConfig(connection.config);
  const payloadIssueId =
    typeof payload === 'object' && payload != null
      ? (payload as Record<string, unknown>).issueId
      : undefined;
  const issueId: string | null =
    (typeof payloadIssueId === 'string'
      ? payloadIssueId
      : typeof config.defaultProjectKey === 'string'
        ? null
        : null) ?? null;

  if (
    issueId &&
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
    await fetchIssue({ apiToken, config }, issueId);
  }

  return {
    connectionId,
    issueId: issueId ?? undefined,
    provider: 'issue_tracker',
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
    case 'issue_tracker': {
      if (!input.connectionId) {
        throw ApplicationFailure.nonRetryable('issue_tracker workspace requires a connectionId');
      }
      return resolveIssueTrackerWorkspace(input.connectionId, input.payload);
    }
    case 'record': {
      if (!input.connectionId) {
        throw ApplicationFailure.nonRetryable('record workspace requires a connectionId');
      }
      return resolveRecordWorkspace(input.connectionId, input.payload);
    }
    default:
      throw ApplicationFailure.nonRetryable(
        `Unknown workspace provider: ${(input as ResolveWorkspaceInput).workspaceProvider}`
      );
  }
}
