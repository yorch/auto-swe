import type { KubernetesWorkspaceConfig } from '@auto-swe/shared/lib/systemConfig';
import type { WorkspaceContainerSpec } from '../types.js';

/** The container every exec targets; the pod has no other. */
export const WORKSPACE_CONTAINER = 'workspace';

/** Where the agent's working tree lives (an `emptyDir`, so it dies with the pod). */
export const WORKSPACE_MOUNT = '/workspace';

/** Selects workspace pods for the NetworkPolicy, the janitor and `kubectl get`. */
export const WORKSPACE_ROLE_LABEL = 'asw/role';
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';

const MEMORY_UNITS: Record<string, number> = { '': 1, b: 1, g: 1024 ** 3, k: 1024, m: 1024 ** 2 };

/**
 * A Docker memory string (`4g`, `512m`, a bare byte count) in bytes. Docker's
 * suffixes are binary (`g` is GiB), which is also what a Kubernetes `Gi` is.
 */
export function dockerMemoryBytes(memory: string): number {
  const match = /^(\d+)([bkmg]?)$/i.exec(memory.trim());
  if (!match) {
    throw new Error(`invalid memory value: ${memory}`);
  }
  return Number(match[1]) * (MEMORY_UNITS[(match[2] ?? '').toLowerCase()] ?? 1);
}

/** `NAME=value` pairs as Kubernetes `env` entries. */
function envEntries(pairs: string[] | undefined): { name: string; value: string }[] {
  return (pairs ?? []).map((pair) => {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`invalid environment entry (expected NAME=value): ${pair.slice(0, 40)}`);
    }
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
  });
}

/**
 * The Pod for one agent workspace.
 *
 * Every field here is either a PodSecurity `restricted` requirement or a
 * Docker-driver hardening item carried over:
 *  - no service-account token, no service-link env, no host namespaces, no
 *    host paths: the pod cannot talk to the Kubernetes API or see the node;
 *  - `runAsNonRoot` with an explicit uid, all capabilities dropped,
 *    privilege escalation off, the runtime-default seccomp profile;
 *  - requests equal limits (Guaranteed QoS), so a running agent is not the
 *    first thing evicted under node pressure;
 *  - the GCP metadata hostnames resolve to 0.0.0.0, as the Docker
 *    `--add-host` pair does (the IP form is NetworkPolicy's job);
 *  - `shareProcessNamespace` makes the pod's `pause` process PID 1 — it reaps
 *    orphans, the role `--init` plays under Docker — and leaves `sleep` as its
 *    only child, which is what the keeper-PID probe looks for;
 *  - `activeDeadlineSeconds` is a hard lifetime the kubelet enforces even if
 *    the worker dies.
 *
 * Deliberately not set: a PID limit (Kubernetes has only the node-wide
 * `podPidsLimit`), `dnsConfig` (workspaces use cluster DNS so a Service name
 * for the worker's proxies resolves — `spec.dns` is not applied), and
 * `spec.network` / `spec.reachWorker` (a pod is on the cluster network; reaching
 * the worker is a Service URL the deployment advertises).
 */
export function buildWorkspacePod(
  spec: WorkspaceContainerSpec,
  config: KubernetesWorkspaceConfig
): Record<string, unknown> {
  const cpu = `${Math.max(1, Math.round(spec.cpus * 1000))}m`;
  const memory = String(dockerMemoryBytes(spec.memory));
  const resources = { cpu: cpu, 'ephemeral-storage': config.storageLimit, memory: memory };
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      labels: { [MANAGED_BY_LABEL]: 'auto-swe', [WORKSPACE_ROLE_LABEL]: 'workspace' },
      name: spec.name,
      namespace: config.namespace,
    },
    spec: {
      activeDeadlineSeconds: config.maxLifetimeSec,
      automountServiceAccountToken: false,
      containers: [
        {
          command: ['sleep', 'infinity'],
          env: envEntries(spec.env),
          image: spec.image,
          name: WORKSPACE_CONTAINER,
          resources: { limits: resources, requests: resources },
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            runAsGroup: config.runAsUser,
            runAsNonRoot: true,
            runAsUser: config.runAsUser,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          volumeMounts: [{ mountPath: WORKSPACE_MOUNT, name: 'workspace' }],
        },
      ],
      enableServiceLinks: false,
      hostAliases: [
        { hostnames: ['metadata.google.internal', 'metadata.gke.internal'], ip: '0.0.0.0' },
      ],
      hostIPC: false,
      hostNetwork: false,
      hostPID: false,
      ...(config.imagePullSecrets.length > 0
        ? { imagePullSecrets: config.imagePullSecrets.map((name) => ({ name })) }
        : {}),
      restartPolicy: 'Never',
      ...(config.runtimeClassName ? { runtimeClassName: config.runtimeClassName } : {}),
      securityContext: {
        fsGroup: config.runAsUser,
        runAsGroup: config.runAsUser,
        runAsNonRoot: true,
        runAsUser: config.runAsUser,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      shareProcessNamespace: true,
      terminationGracePeriodSeconds: 1,
      volumes: [{ emptyDir: { sizeLimit: config.storageLimit }, name: 'workspace' }],
    },
  };
}
