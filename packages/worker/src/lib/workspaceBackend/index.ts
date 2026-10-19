import { dockerWorkspaceBackend } from './docker.js';
import type { WorkspaceBackend } from './types.js';

export type {
  WorkspaceBackend,
  WorkspaceContainerSpec,
  WorkspaceExecOptions,
  WorkspaceHandle,
  WorkspaceSpawnOptions,
} from './types.js';

/**
 * The workspace execution substrate. Only the Docker driver exists — there is
 * deliberately no env var or config selecting a backend; the seam exists so a
 * second driver (Kubernetes pods) can land without unwiring call sites.
 */
export function workspaceBackend(): WorkspaceBackend {
  return dockerWorkspaceBackend();
}
