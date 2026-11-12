import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const hasHelm = spawnSync('helm', ['version', '--short']).status === 0;
const values = [
  'urls.api=https://api.example.invalid',
  'urls.web=https://web.example.invalid',
  'temporal.address=temporal:7233',
  'secrets.existingSecret=fixture',
];
function render(extra = []) {
  return spawnSync(
    'helm',
    [
      'template',
      'fixture',
      'deploy/helm/auto-swe',
      ...[...values, ...extra].flatMap((value) => ['--set', value]),
    ],
    { cwd: root, encoding: 'utf8' }
  );
}

it('provides a node-scoped reference Kata RuntimeClass with VM overhead', () => {
  const manifest = readFileSync(
    new URL('../infra/kubernetes/kata-runtimeclass.yaml', import.meta.url),
    'utf8'
  );
  expect(manifest).toContain('handler: kata');
  expect(manifest).toContain('cpu: 250m');
  expect(manifest).toContain('memory: 160Mi');
  expect(manifest).toContain('katacontainers.io/kata-runtime: "true"');
});

describe.runIf(hasHelm)('Helm RuntimeClass rendering', () => {
  it('leaves the default runtime and legacy env gate unchanged', () => {
    const result = render();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('kind: RuntimeClass');
    expect(result.stdout).not.toContain('name: K8S_REQUIRE_RUNTIME_CLASS');
  });
  it('creates the selected Kata class, overhead, scoped reader and required probe', () => {
    const result = render([
      'workspaces.runtimeClassName=kata',
      'workspaces.requireRuntimeClass=true',
      'workspaces.kataRuntimeClass.create=true',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/kind: RuntimeClass\nmetadata:\n {2}name: "kata"/);
    expect(result.stdout).toContain('handler: kata');
    expect(result.stdout).toContain('memory: 160Mi');
    expect(result.stdout).toContain('cpu: 250m');
    expect(result.stdout).toContain('katacontainers.io/kata-runtime: "true"');
    expect(result.stdout).toContain('resourceNames: ["kata"]');
    expect(result.stdout).toContain('verbs: [get]');
    expect(result.stdout).toMatch(/name: K8S_REQUIRE_RUNTIME_CLASS\n\s+value: "true"/);
    expect(result.stdout).toMatch(/name: K8S_WORKSPACE_RUNTIME_CLASS\n\s+value: "kata"/);
  });
  it('can reference an existing class without creating or owning it', () => {
    const result = render([
      'workspaces.runtimeClassName=operator-kata',
      'workspaces.requireRuntimeClass=true',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('kind: RuntimeClass');
    expect(result.stdout).toContain('resourceNames: ["operator-kata"]');
  });
  it.each(['workspaces.requireRuntimeClass=true', 'workspaces.kataRuntimeClass.create=true'])(
    'rejects %s without a class name',
    (value) => {
      const result = render([value]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('workspaces.runtimeClassName is required');
    }
  );
  it('leaves runtime reader permissions to externally managed workspace RBAC', () => {
    const result = render(['workspaces.runtimeClassName=kata', 'workspaces.manage=false']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('resources: [runtimeclasses]');
  });
  it('does not depend on admission-policy resources or checks', () => {
    const result = render([
      'workspaces.runtimeClassName=kata',
      'workspaces.requireRuntimeClass=true',
    ]);
    expect(result.status, result.stderr).toBe(0);
    const runtimeResources = result.stdout
      .split(/^---/m)
      .filter((document) => document.includes('templates/runtimeclass.yaml'))
      .join('\n');
    expect(runtimeResources).toContain('apiGroups: [node.k8s.io]');
    expect(runtimeResources).not.toContain('admissionregistration');
    expect(runtimeResources).not.toContain('ValidatingAdmissionPolicy');
  });
});
