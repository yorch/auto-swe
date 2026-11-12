import { type PreviewConfig, PreviewConfigSchema } from '@auto-swe/shared/lib/previewConfig';
import {
  parseRepoGatesYaml,
  parseRepoPreviewYaml,
  REPO_GATES_FILE,
  REPO_PREVIEW_FILE,
  type RepoGateFileCommands,
} from '@auto-swe/shared/lib/repoConfigFiles';
import { ApplicationFailure } from '@temporalio/activity';
import type { Workspace } from '../activities/workspace.js';
import { getScmProvider, toRepoRef } from './scm/index.js';
import type { RepoRef, ScmProvider } from './scm/types.js';
import { recordSetupFailure } from './setupBlockerRecorder.js';

export interface RepoConfigReader {
  read(path: string): Promise<string | null>;
  setupBlockers?: boolean;
  connectionId?: string;
}

export function workspaceConfigReader(
  workspace: Pick<Workspace, 'readBaseFile'>,
  connectionId?: string
): RepoConfigReader {
  return { connectionId, read: (path) => workspace.readBaseFile(path), setupBlockers: true };
}

export async function scmConfigReader(
  provider: ScmProvider,
  repo: RepoRef,
  baseBranch: string
): Promise<RepoConfigReader> {
  const sha = await provider.resolveRef(repo, baseBranch);
  if (!sha) {
    throw ApplicationFailure.nonRetryable(
      `Could not resolve trusted base branch ${baseBranch}`,
      'REPO_CONFIG_READ_FAILED'
    );
  }
  return { read: (path) => provider.fetchFileContent(repo, path, sha) };
}

async function invalidFile(reader: RepoConfigReader, path: string, error: string): Promise<never> {
  const message = `Invalid ${path}: ${error}`;
  const failure = ApplicationFailure.create({
    details: reader.setupBlockers
      ? [{ detail: message.slice(-2000), kind: 'invalid_config', subject: path }]
      : [],
    message,
    nonRetryable: true,
    type: reader.setupBlockers ? 'WORKSPACE_SETUP_FAILED' : 'REPO_CONFIG_INVALID',
  });
  if (reader.connectionId) {
    await recordSetupFailure(reader.connectionId, failure);
  }
  throw failure;
}

export async function resolveRepoGateCommands(
  reader: RepoConfigReader
): Promise<RepoGateFileCommands> {
  const text = await reader.read(REPO_GATES_FILE);
  if (text === null) {
    return {};
  }
  const parsed = parseRepoGatesYaml(text);
  return parsed.ok ? parsed.value : invalidFile(reader, REPO_GATES_FILE, parsed.error);
}

export async function resolveRepoPreview(
  reader: RepoConfigReader,
  connection: unknown
): Promise<PreviewConfig | null> {
  if (connection !== null && connection !== undefined) {
    return PreviewConfigSchema.parse(connection);
  }
  const text = await reader.read(REPO_PREVIEW_FILE);
  if (text === null) {
    return null;
  }
  const parsed = parseRepoPreviewYaml(text);
  return parsed.ok ? parsed.value : invalidFile(reader, REPO_PREVIEW_FILE, parsed.error);
}

export function resolvePreviewFromScm(
  repo: Parameters<typeof toRepoRef>[0] & { previewConfig?: unknown },
  baseBranch: string | (() => Promise<string>)
): Promise<PreviewConfig | null> {
  return resolveRepoPreview(
    {
      read: async (path) => {
        const ref = toRepoRef(repo);
        const reader = await scmConfigReader(
          getScmProvider(ref),
          ref,
          typeof baseBranch === 'string' ? baseBranch : await baseBranch()
        );
        return reader.read(path);
      },
    },
    repo.previewConfig
  );
}

export function configuredGateCommand(
  gate: string,
  connection: unknown,
  file: unknown
): { command: string; source: 'configured' | 'repo-file' } | null {
  for (const [value, source] of [
    [connection, 'configured'],
    [file, 'repo-file'],
  ] as const) {
    const command =
      value && typeof value === 'object' ? (value as Record<string, unknown>)[gate] : undefined;
    if (typeof command === 'string' && command.trim()) {
      return { command, source };
    }
  }
  return null;
}
