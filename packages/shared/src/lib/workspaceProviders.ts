import { z } from 'zod';

/**
 * Registry of supported workspace provider types.
 *
 * A workspace provider materializes the container or context in which an agent
 * performs work for a run. The `git_repo` provider is the existing SWE
 * implementation; the others are the placeholders for the horizontal expansion.
 */

export const WORKSPACE_PROVIDER_TYPES = [
  'git_repo',
  'document',
  'issue_tracker',
  'record',
  'api_only',
] as const;

export type WorkspaceProviderType = (typeof WORKSPACE_PROVIDER_TYPES)[number];

export interface WorkspaceProviderMetadata {
  key: WorkspaceProviderType;
  label: string;
  description: string;
  /** Connection type this provider consumes, when the workspace is backed by one. */
  connectionType?: 'git_repo' | 'issue_tracker' | 'notion' | 'zendesk' | 'hubspot';
}

const METADATA: Record<WorkspaceProviderType, WorkspaceProviderMetadata> = {
  api_only: {
    connectionType: undefined,
    description:
      'No persistent local container; the agent calls APIs and returns a structured result.',
    key: 'api_only',
    label: 'API-only',
  },
  document: {
    connectionType: 'notion',
    description: 'Load source documents, draft and review content, and publish the result.',
    key: 'document',
    label: 'Document workspace',
  },
  git_repo: {
    connectionType: 'git_repo',
    description: 'Clone a branch, run tests and builds, and open a pull request.',
    key: 'git_repo',
    label: 'Git repository',
  },
  issue_tracker: {
    connectionType: 'issue_tracker',
    description: 'Fetch and create issues in Linear or Jira.',
    key: 'issue_tracker',
    label: 'Issue tracker',
  },
  record: {
    connectionType: 'zendesk',
    description: 'Fetch and mutate records in a CRM or ticketing system.',
    key: 'record',
    label: 'Record workspace',
  },
};

export const WorkspaceProviderTypeSchema = z.enum(WORKSPACE_PROVIDER_TYPES);

export function isWorkspaceProviderType(value: unknown): value is WorkspaceProviderType {
  return (
    typeof value === 'string' && (WORKSPACE_PROVIDER_TYPES as readonly string[]).includes(value)
  );
}

export function getWorkspaceProviderMetadata(
  type: WorkspaceProviderType
): WorkspaceProviderMetadata {
  return METADATA[type];
}

export function listWorkspaceProviderTypes(): WorkspaceProviderMetadata[] {
  return WORKSPACE_PROVIDER_TYPES.map((key) => METADATA[key]);
}
