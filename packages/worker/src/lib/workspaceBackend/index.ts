import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { dockerWorkspaceBackend } from './docker.js';
import { kubernetesWorkspaceBackend } from './kubernetes/driver.js';
import type { WorkspaceBackend } from './types.js';

export type {
  WorkspaceBackend,
  WorkspaceContainerSpec,
  WorkspaceExecOptions,
  WorkspaceHandle,
  WorkspaceSpawnOptions,
} from './types.js';

/**
 * The workspace execution substrate: the local Docker daemon unless
 * `WORKSPACE_BACKEND=kubernetes`. Chosen per process from the environment, not
 * per request — a worker has one substrate, and it is read where a worker
 * would have to restart to use another anyway.
 */
export function workspaceBackend(): WorkspaceBackend {
  return resolveWorkspaceInfra().backend === 'kubernetes'
    ? kubernetesWorkspaceBackend()
    : dockerWorkspaceBackend();
}
