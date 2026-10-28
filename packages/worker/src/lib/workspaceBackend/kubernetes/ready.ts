import crypto from 'node:crypto';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { spawnCaptureAsync } from '../../execUtils.js';
import { agentWorkspaceSpec } from '../spec.js';
import type { WorkspaceBackend } from '../types.js';

/** Cloud metadata endpoint: the address a workspace must never reach. */
const METADATA_TARGET = { host: '169.254.169.254', label: 'the cloud metadata endpoint', port: 80 };

/**
 * `wget` against `host:port`, printing its own exit status last. BusyBox
 * `wget` exits 8 on an HTTP error status and 1 on a connection failure, and
 * says why on stderr, which is what tells a dropped packet from a refusal.
 */
function probeScript(host: string, port: number): string {
  return `wget -q -T 3 -t 1 -O /dev/null http://${host}:${port}/ 2>&1; echo "asw_exit=$?"`;
}

/**
 * Whether a probe output means the connection was swallowed (a NetworkPolicy
 * drop shows as a timeout; a local block as unreachable) as opposed to
 * answered. "Connection refused" is an answer: some host sent a reset, so the
 * packet got through.
 */
export function wasBlocked(output: string): boolean {
  const exit = /asw_exit=(\d+)/.exec(output)?.[1];
  if (exit === '0' || exit === '8') {
    return false;
  }
  return /timed out|timeout|unreachable|no route|not permitted/i.test(output);
}

interface ReadyDeps {
  backend: WorkspaceBackend;
  /** Environment of the worker, for the cluster API address. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Prove NetworkPolicy is enforced for workspace pods by trying the two
 * connections a workspace must not make from inside one. Without enforcement
 * the namespace's policy is inert: no metadata block, no egress control, and
 * nothing else reports it — the pods run happily. So the worker refuses to
 * start rather than hand an agent a network it was told is closed.
 *
 * Probes: the cloud metadata IP, and the cluster's own API Service address
 * (`KUBERNETES_SERVICE_HOST`, present in any pod the worker itself runs in).
 * Skipped with a warning when the worker is outside the cluster and the second
 * address is unknown; the metadata probe still runs.
 */
export async function assertNetworkPolicyEnforced(deps: ReadyDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const targets = [METADATA_TARGET];
  const apiHost = env.KUBERNETES_SERVICE_HOST;
  if (apiHost) {
    targets.push({
      host: apiHost,
      label: 'the cluster API address',
      port: Number(env.KUBERNETES_SERVICE_PORT) || 443,
    });
  } else {
    console.warn(
      '[workspace] KUBERNETES_SERVICE_HOST is unset (worker outside the cluster?); ' +
        'the NetworkPolicy check only probes the cloud metadata endpoint.'
    );
  }

  const infra = resolveWorkspaceInfra();
  const name = `workspace-netcheck-${crypto.randomBytes(4).toString('hex')}`;
  const handle = await (async () => {
    try {
      return await deps.backend.create(agentWorkspaceSpec(name, infra.metadataBlockImage, infra));
    } catch (err) {
      await deps.backend.remove(name);
      throw err;
    }
  })();
  try {
    const reached: string[] = [];
    for (const target of targets) {
      const result = await deps.backend.exec(
        handle,
        ['sh', '-c', probeScript(target.host, target.port)],
        { heartbeatLabel: 'workspace: checking NetworkPolicy', timeoutMs: 30_000 }
      );
      const output = `${result.stdout}\n${result.stderr}`;
      if (!wasBlocked(output)) {
        reached.push(
          `${target.label} (${target.host}:${target.port}): ${output.trim().slice(0, 200)}`
        );
      }
    }
    if (reached.length > 0) {
      throw new Error(
        'NetworkPolicy is not enforced for workspace pods — a probe pod reached ' +
          `${reached.join('; ')}. Use a CNI that enforces NetworkPolicy (and apply the ` +
          'workspace namespace policy), or set K8S_REQUIRE_NETWORK_POLICY=false on a ' +
          'cluster where that is understood and accepted.'
      );
    }
  } finally {
    await deps.backend.remove(handle);
  }
}

/** The verbs the worker needs, by resource: pods and their exec, and each pod's Secret. */
const REQUIRED_VERBS: [resource: string, verbs: string[]][] = [
  ['pods', ['create', 'get', 'delete']],
  ['pods/exec', ['create']],
  ['secrets', ['create', 'patch', 'delete']],
];

/**
 * The worker may create, exec into and delete pods in the workspace
 * namespace, and create, patch and delete the Secret that carries a pod's
 * credentials (never read it). Cheap to check, and a missing verb otherwise surfaces as a
 * Forbidden halfway through someone's first run.
 */
export async function assertWorkspaceRbac(): Promise<void> {
  const { kubectl, namespace } = resolveWorkspaceInfra().kubernetes;
  for (const [resource, verbs] of REQUIRED_VERBS) {
    for (const verb of verbs) {
      const result = await spawnCaptureAsync(
        kubectl,
        ['auth', 'can-i', verb, resource, '--namespace', namespace],
        { heartbeatLabel: 'workspace: checking RBAC', timeoutMs: 30_000 }
      );
      if (result.exitCode !== 0 || !/^yes/i.test(result.stdout.trim())) {
        throw new Error(
          `the worker cannot ${verb} ${resource} in namespace ${namespace}: ` +
            `${(result.stdout || result.stderr).trim().slice(0, 200)}`
        );
      }
    }
  }
}

/** Everything a worker with `WORKSPACE_BACKEND=kubernetes` checks before it takes work. */
export async function assertKubernetesReady(backend: WorkspaceBackend): Promise<void> {
  await assertWorkspaceRbac();
  if (resolveWorkspaceInfra().kubernetes.requireNetworkPolicy) {
    await assertNetworkPolicyEnforced({ backend });
  } else {
    console.warn(
      '[workspace] K8S_REQUIRE_NETWORK_POLICY=false: not verifying NetworkPolicy enforcement. ' +
        'Without it workspaces may reach the cloud metadata endpoint and internal addresses.'
    );
  }
}
