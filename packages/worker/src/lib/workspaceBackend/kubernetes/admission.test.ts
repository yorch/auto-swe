import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { KubernetesWorkspaceConfig } from '@auto-swe/shared/lib/systemConfig';
import { beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceContainerSpec } from '../types.js';
import { buildWorkspacePod } from './podSpec.js';

const reference = 'infra/kubernetes/workspace-admission.yaml';
const chart = 'deploy/helm/auto-swe/templates/_workspace-admission.tpl';
function expressions(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/^ {4}- expression: (".*")$/gm)].map((match) =>
    JSON.parse(match[1] ?? '""')
  );
}
it('keeps Helm and reference CEL identical and covers Pod updates and ephemeral containers', () => {
  expect(expressions(reference)).toHaveLength(7);
  expect(expressions(chart)).toEqual(expressions(reference));
  for (const file of [reference, chart]) {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('operations: [CREATE, UPDATE]');
    expect(source).toContain('resources: [pods, pods/ephemeralcontainers]');
    expect(source).toContain('failurePolicy: Fail');
    expect(source).toContain('validationActions: [Deny]');
  }
  expect(readFileSync('infra/kubernetes/workspace-namespace.yaml', 'utf8')).toContain(
    'pod-security.kubernetes.io/enforce: restricted'
  );
  expect(readFileSync('deploy/helm/auto-swe/templates/workspaces.yaml', 'utf8')).toContain(
    'pod-security.kubernetes.io/enforce: restricted'
  );
});

const config: KubernetesWorkspaceConfig = {
  imagePullSecrets: [],
  kubectl: 'kubectl',
  maxLifetimeSec: 3600,
  namespace: 'auto-swe-workspaces',
  requireNetworkPolicy: true,
  requireRuntimeClass: true,
  runAsUser: 1000,
  runtimeClassName: 'gvisor',
  storageLimit: '10Gi',
};
const spec: WorkspaceContainerSpec = {
  cpus: 1,
  dns: [],
  image: 'node:24-alpine',
  memory: '128m',
  name: 'workspace-admission',
  network: 'none',
  pidsLimit: 64,
  reachWorker: true,
};
function pod(extra: Partial<WorkspaceContainerSpec> = {}) {
  return JSON.parse(JSON.stringify(buildWorkspacePod({ ...spec, ...extra }, config)));
}
function kubectl(args: string[], input?: unknown) {
  return spawnSync(
    process.env.K8S_ADMISSION_TEST_KUBECTL || 'kubectl',
    ['--kubeconfig', process.env.K8S_ADMISSION_TEST_CONFIG || '', ...args],
    {
      encoding: 'utf8',
      input: input === undefined ? undefined : JSON.stringify(input),
      timeout: 30_000,
    }
  );
}
function apply(input: unknown) {
  const result = kubectl(['apply', '-f', '-'], input);
  expect(result.stderr, result.stderr).not.toContain('Error');
  expect(result.status, result.stderr).toBe(0);
}
// K8S_ADMISSION_TEST_CONFIG must point at a disposable API server, never a deployment.
describe.skipIf(!process.env.K8S_ADMISSION_TEST_CONFIG)(
  'workspace CEL on a real API server',
  () => {
    beforeAll(async () => {
      apply({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          labels: {
            'asw/required-runtime-class': 'gvisor',
            'asw/workspace-service-account': 'designated',
            'pod-security.kubernetes.io/enforce': 'restricted',
          },
          name: config.namespace,
        },
      });
      for (const name of ['default', 'designated', 'foreign']) {
        apply({
          apiVersion: 'v1',
          kind: 'ServiceAccount',
          metadata: { name, namespace: config.namespace },
        });
      }
      for (const name of ['gvisor', 'wrong']) {
        apply({
          apiVersion: 'node.k8s.io/v1',
          handler: 'runc',
          kind: 'RuntimeClass',
          metadata: { name },
        });
      }
      const applied = kubectl(['apply', '-f', reference]);
      expect(applied.status, applied.stderr).toBe(0);
      // Exercise a known violation as an enforcement barrier, not just resource existence.
      for (let attempt = 0; attempt < 60; attempt++) {
        const bad = pod();
        bad.metadata.labels = {};
        const result = kubectl(['create', '--dry-run=server', '-f', '-'], bad);
        if (result.stderr.includes('asw/role must be workspace')) {
          return;
        }
        await setTimeout(100);
      }
      throw new Error('workspace admission binding did not become enforcing');
    }, 30_000);
    it.each([
      ['workspace', {}],
      ['trusted/probe', { trusted: true }],
      ['secret env', { secretEnv: { EXAMPLE_TOKEN: 'fixture' } }],
      [
        'non-root preview',
        {
          services: [
            {
              env: { PASSWORD: 'fixture' },
              image: 'node:24-alpine',
              name: 'preview',
              runAsUser: 1000,
            },
          ],
        },
      ],
    ] as const)('admits generated %s pods', (_name, extra) => {
      const result = kubectl(
        ['create', '--dry-run=server', '-f', '-'],
        pod(extra as Partial<WorkspaceContainerSpec>)
      );
      expect(result.status, result.stderr).toBe(0);
    });
    it('allows a designated service account but does not require it', () => {
      const input = pod();
      input.spec.serviceAccountName = 'designated';
      const result = kubectl(['create', '--dry-run=server', '-f', '-'], input);
      expect(result.status, result.stderr).toBe(0);
    });
    it('does not apply workspace admission to other namespaces', () => {
      apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'admission-outside' } });
      apply({
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: 'default', namespace: 'admission-outside' },
      });
      const input = pod();
      input.metadata.namespace = 'admission-outside';
      input.metadata.labels = {};
      input.spec.automountServiceAccountToken = true;
      const result = kubectl(['create', '--dry-run=server', '-f', '-'], input);
      expect(result.status, result.stderr).toBe(0);
    });
    const badPods: [string, (input: ReturnType<typeof pod>) => void, string][] = [
      [
        'missing role',
        (p) => {
          delete p.metadata.labels;
        },
        'asw/role must be workspace',
      ],
      [
        'wrong role',
        (p) => {
          p.metadata.labels['asw/role'] = 'other';
        },
        'asw/role must be workspace',
      ],
      [
        'automount true',
        (p) => {
          p.spec.automountServiceAccountToken = true;
        },
        'automount must be false',
      ],
      [
        'automount absent',
        (p) => {
          delete p.spec.automountServiceAccountToken;
        },
        'automount must be false',
      ],
      [
        'foreign SA',
        (p) => {
          p.spec.serviceAccountName = 'foreign';
        },
        'service account is allowed',
      ],
      [
        'missing runtime',
        (p) => {
          delete p.spec.runtimeClassName;
        },
        'runtimeClassName must match',
      ],
      [
        'wrong runtime',
        (p) => {
          p.spec.runtimeClassName = 'wrong';
        },
        'runtimeClassName must match',
      ],
      [
        'Secret volume',
        (p) => {
          p.spec.volumes.push({ name: 'bad', secret: { secretName: 'foreign' } });
        },
        'volumes or projections are allowed',
      ],
      [
        'PVC volume',
        (p) => {
          p.spec.volumes.push({ name: 'bad', persistentVolumeClaim: { claimName: 'foreign' } });
        },
        'volumes or projections are allowed',
      ],
      [
        'projected token',
        (p) => {
          p.spec.volumes.push({
            name: 'bad',
            projected: { sources: [{ serviceAccountToken: { path: 'token' } }] },
          });
        },
        'volumes or projections are allowed',
      ],
      [
        'projected Secret',
        (p) => {
          p.spec.volumes.push({
            name: 'bad',
            projected: { sources: [{ secret: { name: 'foreign' } }] },
          });
        },
        'volumes or projections are allowed',
      ],
      [
        'envFrom',
        (p) => {
          p.spec.containers[0].envFrom = [{ secretRef: { name: 'foreign' } }];
        },
        'envFrom is forbidden',
      ],
      [
        'foreign secretKeyRef',
        (p) => {
          p.spec.containers[0].env = [
            { name: 'TOKEN', valueFrom: { secretKeyRef: { key: 'TOKEN', name: 'foreign-env' } } },
          ];
        },
        "this pod's own -env Secret",
      ],
      [
        'init secretKeyRef',
        (p) => {
          p.spec.initContainers = [
            {
              ...p.spec.containers[0],
              env: [
                {
                  name: 'TOKEN',
                  valueFrom: { secretKeyRef: { key: 'TOKEN', name: 'foreign-env' } },
                },
              ],
              name: 'init',
            },
          ];
        },
        "this pod's own -env Secret",
      ],
    ];
    it.each(badPods)('rejects crafted %s', (_name, change, message) => {
      const input = pod();
      change(input);
      const result = kubectl(['create', '--dry-run=server', '-f', '-'], input);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(message);
    });
    it('keeps root preview services rejected by PodSecurity restricted', () => {
      const input = pod({ services: [{ image: 'node:24-alpine', name: 'preview' }] });
      const result = kubectl(['create', '--dry-run=server', '-f', '-'], input);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('violates PodSecurity');
    });
    it('rejects hostPath even when the remaining pod matches the worker', () => {
      const input = pod();
      input.spec.volumes.push({ hostPath: { path: '/' }, name: 'host' });
      const result = kubectl(['create', '--dry-run=server', '-f', '-'], input);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('violates PodSecurity');
    });
    it('enforces Pod updates and the ephemeralcontainers subresource', () => {
      const input = pod();
      const created = kubectl(['create', '-f', '-'], input);
      expect(created.status, created.stderr).toBe(0);
      try {
        const update = kubectl([
          'patch',
          'pod',
          spec.name,
          '-n',
          config.namespace,
          '--type=merge',
          '-p',
          JSON.stringify({ metadata: { labels: { 'asw/role': null } } }),
        ]);
        expect(update.status).not.toBe(0);
        expect(update.stderr).toContain('asw/role must be workspace');
        const debug = {
          env: [
            { name: 'TOKEN', valueFrom: { secretKeyRef: { key: 'TOKEN', name: 'foreign-env' } } },
          ],
          image: spec.image,
          name: 'debug',
          securityContext: input.spec.containers[0].securityContext,
        };
        const ephemeral = kubectl([
          'patch',
          'pod',
          spec.name,
          '-n',
          config.namespace,
          '--subresource=ephemeralcontainers',
          '--type=merge',
          '-p',
          JSON.stringify({ spec: { ephemeralContainers: [debug] } }),
        ]);
        expect(ephemeral.status).not.toBe(0);
        expect(ephemeral.stderr).toContain("this pod's own -env Secret");
      } finally {
        kubectl(['delete', 'pod', spec.name, '-n', config.namespace, '--wait=false']);
      }
    });
  }
);
