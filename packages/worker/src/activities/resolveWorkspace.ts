import {
  decryptConnectionApiToken,
  parseConfluenceConnectionConfig,
  parseIssueTrackerConnectionConfig,
  parseNotionConnectionConfig,
  parseZendeskConnectionConfig,
} from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import type { WorkspaceProviderType } from '@auto-swe/shared/lib/workspaceProviders';
import { ApplicationFailure } from '@temporalio/activity';
import { readConfluencePage } from '../connectors/confluence.js';
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
  // `githubUrl` is the web BASE (e.g. a GitHub Enterprise host), exactly as the
  // SCM provider reads it when it clones — not a repository URL — and its
  // absence means the instance's configured host, not github.com.
  const baseUrl = (connection.githubUrl ?? (await resolveGitHubConfig()).baseUrl).replace(
    /\/$/,
    ''
  );
  return {
    branch: connection.defaultBranch,
    cloneUrl: `${baseUrl}/${connection.organizationName}/${connection.repoName}.git`,
    connectionId,
    defaultBranch: connection.defaultBranch,
    provider: 'git_repo',
    repoName: connection.repoName,
    repoOwner: connection.organizationName,
  };
}

/**
 * Read the page a document workspace is anchored on, when one is named, so a
 * missing page fails here rather than midway through a run that has already
 * spent on an agent. Best-effort by design: an unnamed or unreadable page is not
 * an error, the step that reads it is.
 */
async function probeDocumentSource(
  connection: {
    apiKeyAuthTag: Buffer | Uint8Array | null;
    apiKeyCiphertext: Buffer | Uint8Array | null;
    apiKeyNonce: Buffer | Uint8Array | null;
    apiKeyVersion: number;
    config: unknown;
    type: string;
  },
  sourceId: string
): Promise<void> {
  if (!connection.apiKeyCiphertext || !connection.apiKeyNonce || !connection.apiKeyAuthTag) {
    return;
  }
  const apiToken = decryptConnectionApiToken({
    apiKeyAuthTag: connection.apiKeyAuthTag,
    apiKeyCiphertext: connection.apiKeyCiphertext,
    apiKeyNonce: connection.apiKeyNonce,
    apiKeyVersion: connection.apiKeyVersion,
  });
  if (connection.type === 'confluence') {
    await readConfluencePage(
      { apiToken, config: parseConfluenceConnectionConfig(connection.config) },
      sourceId
    );
    return;
  }
  await readNotionPage({ apiToken }, sourceId);
}

async function resolveDocumentWorkspace(
  connectionId: string,
  payload?: unknown
): Promise<WorkspaceContext> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
  });
  if (!connection?.isActive || (connection.type !== 'notion' && connection.type !== 'confluence')) {
    throw ApplicationFailure.nonRetryable(
      `Connection ${connectionId} is not an active notion or confluence connection`
    );
  }
  const payloadPageId =
    typeof payload === 'object' && payload != null
      ? (payload as Record<string, unknown>).pageId
      : undefined;
  // Only Notion carries a default page to read on the connection: Confluence's
  // `parentPageId` is where a *new* page is created, not a page to read, so a
  // Confluence source page has to be named by the run.
  const configuredSourceId =
    connection.type === 'notion'
      ? parseNotionConnectionConfig(connection.config).sourcePageId
      : undefined;
  const sourceId = (typeof payloadPageId === 'string' ? payloadPageId : configuredSourceId) ?? null;

  if (sourceId) {
    await probeDocumentSource(connection, sourceId);
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
