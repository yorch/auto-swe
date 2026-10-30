import {
  DOCKER_HOST_ALIAS,
  resolveWorkspaceInfra,
  type WorkspaceInfraConfig,
} from '@auto-swe/shared/lib/systemConfig';
import type { WorkspaceContainerSpec, WorkspaceServiceSpec } from './types.js';

/**
 * The {@link WorkspaceContainerSpec} for an agent workspace on `image`, with
 * the caps, resolvers, network and host aliases the deployment configured
 * (`resolveWorkspaceInfra`, or the caller's already-resolved copy). Shared by
 * `createWorkspace` and the executor-image probe so a probed container is
 * hardened exactly like a real workspace — the rest of the hardening (init,
 * cap-drop, keeper) the driver adds itself.
 */
export function agentWorkspaceSpec(
  name: string,
  image: string,
  infra: WorkspaceInfraConfig = resolveWorkspaceInfra(),
  services?: WorkspaceServiceSpec[]
): WorkspaceContainerSpec {
  // With the harness model proxy advertised at the Docker host alias, the alias
  // resolves to the host gateway, so a harness turn can reach the worker's
  // proxy (and never needs the provider credential itself). A deployment can
  // instead put workspaces on a network the worker joins (`WORKSPACE_NETWORK`),
  // which needs no port published on the host.
  const reachWorker =
    (infra.harnessModelProxy &&
      new URL(infra.harnessModelProxy.url).hostname === DOCKER_HOST_ALIAS) ||
    (infra.registryProxy && new URL(infra.registryProxy.url).hostname === DOCKER_HOST_ALIAS);
  return {
    cpus: infra.cpus,
    dns: infra.dns,
    image,
    memory: infra.memory,
    name,
    ...(infra.network ? { network: infra.network } : {}),
    pidsLimit: infra.pidsLimit,
    reachWorker: Boolean(reachWorker),
    ...(services?.length ? { services } : {}),
  };
}
