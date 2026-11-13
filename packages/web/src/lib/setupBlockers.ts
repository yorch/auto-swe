import type { SetupBlocker } from '@auto-swe/shared/lib/setupBlocker';
import { isRecord } from './utils';

export const KIND_LABELS: Record<SetupBlocker['kind'], string> = {
  egress_denied: 'Network access denied',
  git_auth: 'Git authentication failed',
  git_fetch: 'Git fetch failed',
  internal: 'Workspace setup error',
  invalid_config: 'Invalid configuration',
  lfs_missing: 'Git LFS missing',
  missing_secret: 'Missing secret',
  missing_tool: 'Missing tool',
  secret_decrypt_failed: 'Secret decryption failed',
  secret_leak: 'Secret left on disk',
  step_failed: 'Setup step failed',
  step_timeout: 'Setup step timed out',
};

export function setupBlockerLabel(kind: SetupBlocker['kind']): string {
  return Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind] : KIND_LABELS.internal;
}

export function runRepositoryId(contextSnapshot: unknown): string | null {
  const request = isRecord(contextSnapshot) ? contextSnapshot.request : null;
  return isRecord(request) && typeof request.repoId === 'string' && request.repoId.length > 0
    ? request.repoId
    : null;
}
