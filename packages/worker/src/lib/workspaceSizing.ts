import { resolveSetting, SETTING_DEFINITIONS } from '@auto-swe/shared/config';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { logWarn } from './activityLog.js';
import { resolveEgressScope } from './egressWiring.js';

export interface WorkspaceSize {
  memory: string;
  cpus: number;
}

/**
 * The memory and CPU caps for a run's workspaces: `workspace.memory` / `workspace.cpus` as the
 * run pinned them (`currentRequestContext` carries the pinned settings), at the team's scope, and
 * the deployment's `WORKSPACE_MEMORY` / `WORKSPACE_CPUS` for whatever the settings leave unset.
 * Resolved like the run egress policy: pin first, else the live cascade, and with no run context
 * (an eval, a probe) at the given team only.
 *
 * Never throws: it runs while a workspace is being created, and sizing is not worth failing the
 * run over. A resolver error or a stored value the schema refuses yields the environment value.
 */
export async function resolveRunWorkspaceSize(
  teamId: string | null,
  infra = resolveWorkspaceInfra()
): Promise<WorkspaceSize> {
  const size: WorkspaceSize = { cpus: infra.cpus, memory: infra.memory };
  try {
    const scope = await resolveEgressScope(teamId);
    const [memory, cpus] = await Promise.all([
      resolveSetting('workspace.memory', scope),
      resolveSetting('workspace.cpus', scope),
    ]);
    if (memory !== '' && SETTING_DEFINITIONS['workspace.memory'].schema.safeParse(memory).success) {
      size.memory = memory;
    }
    if (cpus !== 0 && SETTING_DEFINITIONS['workspace.cpus'].schema.safeParse(cpus).success) {
      size.cpus = cpus;
    }
  } catch (err) {
    logWarn('workspace sizing setting unreadable; using the deployment values', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return size;
}
