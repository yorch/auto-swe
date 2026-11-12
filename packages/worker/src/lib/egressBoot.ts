import { resolveSetting } from '@auto-swe/shared/config';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';

export async function assertGlobalEgressReady(): Promise<void> {
  const policy = await resolveSetting('workspace.egressPolicy', {});
  if (policy === 'restricted' && !resolveWorkspaceInfra().egressProxy) {
    throw new Error(
      'GLOBAL workspace.egressPolicy is restricted but the egress proxy is not configured. Configure EGRESS_PROXY_PORT (and EGRESS_PROXY_URL on Kubernetes), or set the GLOBAL workspace.egressPolicy to open.'
    );
  }
}
