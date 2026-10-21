import type { KubernetesWorkspaceConfig } from '@auto-swe/shared/lib/systemConfig';
import { describe, expect, it } from 'vitest';
import type { WorkspaceContainerSpec } from '../types.js';
import { buildWorkspacePod, dockerMemoryBytes } from './podSpec.js';

const config: KubernetesWorkspaceConfig = {
  imagePullSecrets: [],
  kubectl: 'kubectl',
  maxLifetimeSec: 3600,
  namespace: 'auto-swe-workspaces',
  requireNetworkPolicy: true,
  runAsUser: 1000,
  runtimeClassName: null,
  storageLimit: '10Gi',
};

const spec: WorkspaceContainerSpec = {
  cpus: 2,
  dns: ['1.1.1.1'],
  env: ['FOO=bar', 'EMPTY=', 'WITH_EQ=a=b'],
  image: 'registry.example/exec:1',
  memory: '4g',
  name: 'workspace-abc123',
  network: 'some-docker-network',
  pidsLimit: 512,
  reachWorker: true,
};

interface PodShape {
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    activeDeadlineSeconds: number;
    automountServiceAccountToken: boolean;
    containers: {
      command: string[];
      env: { name: string; value: string }[];
      resources: { limits: Record<string, string>; requests: Record<string, string> };
      securityContext: Record<string, unknown>;
      volumeMounts: { mountPath: string; name: string }[];
    }[];
    enableServiceLinks: boolean;
    hostAliases: { hostnames: string[]; ip: string }[];
    hostIPC: boolean;
    hostNetwork: boolean;
    hostPID: boolean;
    imagePullSecrets?: { name: string }[];
    restartPolicy: string;
    runtimeClassName?: string;
    securityContext: Record<string, unknown>;
    shareProcessNamespace: boolean;
    volumes: { emptyDir: { sizeLimit: string }; name: string }[];
  };
}
const pod = (over: Partial<KubernetesWorkspaceConfig> = {}) =>
  buildWorkspacePod(spec, { ...config, ...over }) as unknown as PodShape;

describe('dockerMemoryBytes', () => {
  it('reads Docker’s binary suffixes', () => {
    expect(dockerMemoryBytes('4g')).toBe(4 * 1024 ** 3);
    expect(dockerMemoryBytes('512M')).toBe(512 * 1024 ** 2);
    expect(dockerMemoryBytes('64k')).toBe(64 * 1024);
    expect(dockerMemoryBytes('1048576')).toBe(1048576);
    expect(dockerMemoryBytes('7b')).toBe(7);
  });

  it('refuses what Docker would refuse', () => {
    expect(() => dockerMemoryBytes('4gb')).toThrow(/invalid memory/);
    expect(() => dockerMemoryBytes('')).toThrow(/invalid memory/);
  });
});

describe('buildWorkspacePod', () => {
  it('names the pod in the workspace namespace with the labels the policy and janitor select on', () => {
    const p = pod();
    expect(p.metadata.name).toBe('workspace-abc123');
    expect(p.metadata.namespace).toBe('auto-swe-workspaces');
    expect(p.metadata.labels).toEqual({
      'app.kubernetes.io/managed-by': 'auto-swe',
      'asw/role': 'workspace',
    });
  });

  it('meets PodSecurity restricted', () => {
    const { spec: s } = pod();
    const c = s.containers[0];
    expect(s.containers).toHaveLength(1);
    expect(c.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(s.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000 });
    expect(s.hostNetwork).toBe(false);
    expect(s.hostPID).toBe(false);
    expect(s.hostIPC).toBe(false);
    expect(JSON.stringify(s)).not.toContain('hostPath');
    expect(JSON.stringify(s)).not.toContain('privileged');
  });

  it('gives the pod no way to talk to the Kubernetes API', () => {
    const { spec: s } = pod();
    expect(s.automountServiceAccountToken).toBe(false);
    expect(s.enableServiceLinks).toBe(false);
  });

  it('runs as an explicit uid, because a named image USER cannot be proven non-root', () => {
    expect(pod({ runAsUser: 4321 }).spec.containers[0].securityContext.runAsUser).toBe(4321);
  });

  it('sets requests equal to limits (Guaranteed QoS)', () => {
    const r = pod().spec.containers[0].resources;
    expect(r.limits).toEqual(r.requests);
    expect(r.limits).toEqual({
      cpu: '2000m',
      'ephemeral-storage': '10Gi',
      memory: String(4 * 1024 ** 3),
    });
  });

  it('keeps the container alive with sleep under a shared process namespace', () => {
    const { spec: s } = pod();
    expect(s.containers[0].command).toEqual(['sleep', 'infinity']);
    expect(s.shareProcessNamespace).toBe(true);
    expect(s.restartPolicy).toBe('Never');
  });

  it('bounds the pod’s lifetime in the kubelet, not only in the worker', () => {
    expect(pod({ maxLifetimeSec: 120 }).spec.activeDeadlineSeconds).toBe(120);
  });

  it('puts the working tree on a size-limited emptyDir', () => {
    const { spec: s } = pod();
    expect(s.volumes).toEqual([{ emptyDir: { sizeLimit: '10Gi' }, name: 'workspace' }]);
    expect(s.containers[0].volumeMounts).toEqual([{ mountPath: '/workspace', name: 'workspace' }]);
  });

  it('blackholes the GCP metadata hostnames, as the Docker driver does', () => {
    expect(pod().spec.hostAliases).toEqual([
      { hostnames: ['metadata.google.internal', 'metadata.gke.internal'], ip: '0.0.0.0' },
    ]);
  });

  it('splits env on the first = only', () => {
    expect(pod().spec.containers[0].env).toEqual([
      { name: 'FOO', value: 'bar' },
      { name: 'EMPTY', value: '' },
      { name: 'WITH_EQ', value: 'a=b' },
    ]);
    expect(() => buildWorkspacePod({ ...spec, env: ['NOEQUALS'] }, config)).toThrow(/NAME=value/);
  });

  it('adds a runtime class and pull secrets only when configured', () => {
    expect(pod().spec.runtimeClassName).toBeUndefined();
    expect(pod().spec.imagePullSecrets).toBeUndefined();
    const p = pod({ imagePullSecrets: ['regcred'], runtimeClassName: 'gvisor' });
    expect(p.spec.runtimeClassName).toBe('gvisor');
    expect(p.spec.imagePullSecrets).toEqual([{ name: 'regcred' }]);
  });

  it('does not apply Docker-only settings', () => {
    const json = JSON.stringify(pod());
    expect(json).not.toContain('some-docker-network');
    expect(json).not.toContain('1.1.1.1');
    expect(json).not.toContain('pids');
  });
});
