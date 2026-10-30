import type { KubernetesWorkspaceConfig } from '@auto-swe/shared/lib/systemConfig';
import { describe, expect, it } from 'vitest';
import type { WorkspaceContainerSpec } from '../types.js';
import {
  buildWorkspacePod,
  buildWorkspaceSecret,
  dockerMemoryBytes,
  workspaceSecretName,
} from './podSpec.js';

const POD_UID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

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
      env: { name: string; value?: string; valueFrom?: unknown }[];
      image: string;
      name: string;
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

  it('adds root-starting service sidecars without changing workspace security', () => {
    const servicePod = buildWorkspacePod(
      {
        ...spec,
        services: [
          {
            env: { POSTGRES_PASSWORD: 'secret' },
            image: 'mirror.gcr.io/library/postgres:18',
            name: 'postgres',
            port: 5432,
          },
        ],
      },
      config
    ) as unknown as PodShape;
    const workspace = servicePod.spec.containers[0];
    const service = servicePod.spec.containers[1];
    expect(workspace?.name).toBe('workspace');
    expect(workspace?.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      runAsNonRoot: true,
      runAsUser: 1000,
    });
    expect(service?.name).toBe('postgres');
    expect(service?.image).toBe('mirror.gcr.io/library/postgres:18');
    expect(service?.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: {
        add: ['CHOWN', 'SETUID', 'SETGID', 'FOWNER', 'DAC_OVERRIDE'],
        drop: ['ALL'],
      },
      runAsNonRoot: false,
      runAsUser: 0,
    });
    expect(servicePod.spec.securityContext.runAsNonRoot).toBe(true);
    expect(service?.env).toEqual([
      {
        name: 'POSTGRES_PASSWORD',
        valueFrom: {
          secretKeyRef: {
            key: 'ASW_SERVICE_POSTGRES_POSTGRES_PASSWORD',
            name: 'workspace-abc123-env',
            optional: false,
          },
        },
      },
    ]);
    expect(JSON.stringify(servicePod)).not.toContain('"value":"secret"');
    expect(
      buildWorkspaceSecret(
        {
          ...spec,
          services: [
            {
              env: { POSTGRES_PASSWORD: 'sensitive-value' },
              image: 'mirror.gcr.io/library/postgres:18',
              name: 'postgres',
            },
          ],
        },
        config,
        POD_UID
      )
    ).toMatchObject({
      data: {
        ASW_SERVICE_POSTGRES_POSTGRES_PASSWORD: Buffer.from('sensitive-value').toString('base64'),
      },
    });
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

describe('secretEnv', () => {
  const TOKEN = 'tok-s3cret-value';
  const withSecret: WorkspaceContainerSpec = {
    ...spec,
    secretEnv: { COREPACK_NPM_TOKEN: TOKEN, YARN_NPM_AUTH_TOKEN: TOKEN },
  };

  it('references each secret by key and never carries its value in the Pod', () => {
    const p = buildWorkspacePod(withSecret, config) as unknown as PodShape;
    const ref = (name: string) => ({
      name,
      valueFrom: {
        secretKeyRef: { key: name, name: 'workspace-abc123-env', optional: false },
      },
    });
    expect(p.spec.containers[0].env).toEqual([
      { name: 'FOO', value: 'bar' },
      { name: 'EMPTY', value: '' },
      { name: 'WITH_EQ', value: 'a=b' },
      ref('COREPACK_NPM_TOKEN'),
      ref('YARN_NPM_AUTH_TOKEN'),
    ]);
    expect(JSON.stringify(p)).not.toContain(TOKEN);
    expect(JSON.stringify(p)).not.toContain(Buffer.from(TOKEN).toString('base64'));
  });

  it('builds the per-pod Secret with the values, labelled for cleanup', () => {
    const secret = buildWorkspaceSecret(withSecret, config, POD_UID);
    expect(workspaceSecretName('workspace-abc123')).toBe('workspace-abc123-env');
    expect(secret).toEqual({
      apiVersion: 'v1',
      data: {
        COREPACK_NPM_TOKEN: Buffer.from(TOKEN).toString('base64'),
        YARN_NPM_AUTH_TOKEN: Buffer.from(TOKEN).toString('base64'),
      },
      kind: 'Secret',
      metadata: {
        labels: {
          'app.kubernetes.io/managed-by': 'auto-swe',
          'asw/role': 'workspace-env',
          'asw/workspace': 'workspace-abc123',
        },
        name: 'workspace-abc123-env',
        namespace: 'auto-swe-workspaces',
        ownerReferences: [
          { apiVersion: 'v1', kind: 'Pod', name: 'workspace-abc123', uid: POD_UID },
        ],
      },
      type: 'Opaque',
    });
  });

  it('makes no Secret, and no secretKeyRef, without secretEnv', () => {
    expect(buildWorkspaceSecret(spec, config, POD_UID)).toBeNull();
    expect(JSON.stringify(pod())).not.toContain('secretKeyRef');
  });

  it('refuses a name the Secret key cannot carry, and a name that is also plain', () => {
    const badName = { ...spec, secretEnv: { 'bad name': 'x' } };
    const digitFirst = { ...spec, secretEnv: { '1X': 'x' } };
    const clash = { ...spec, secretEnv: { FOO: 'x' } };
    expect(() => buildWorkspacePod(badName, config)).toThrow(/invalid secret environment name/);
    expect(() => buildWorkspaceSecret(digitFirst, config, POD_UID)).toThrow(
      /invalid secret environment/
    );
    expect(() => buildWorkspacePod(clash, config)).toThrow(/both plain and secret/);
  });
});
