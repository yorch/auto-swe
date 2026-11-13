import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnCaptureAsync } from '../../execUtils.js';
import { assertWorkspaceAdmission } from './ready.js';

vi.mock('../../execUtils.js', () => ({ spawnCaptureAsync: vi.fn() }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkspaceInfra: () => ({
    kubernetes: {
      kubectl: 'kubectl',
      namespace: 'ns',
      requireRuntimeClass: process.env.K8S_REQUIRE_RUNTIME_CLASS === 'true',
      runtimeClassName: 'gvisor',
    },
  }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
type Scope = { namespaceSelector: { matchLabels: Record<string, string> } };
type Policy = {
  spec: { failurePolicy: string; matchConstraints: Scope; validations: unknown[] };
  status: { typeChecking: { expressionWarnings: unknown[] } };
};
type Binding = { spec: { policyName: string; validationActions: string[]; matchResources: Scope } };
function responses(change: (policy: Policy, binding: Binding) => void = () => {}) {
  const scope = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ns' } } };
  const policy: Policy = {
    spec: { failurePolicy: 'Fail', matchConstraints: scope, validations: [{}] },
    status: { typeChecking: { expressionWarnings: [] } },
  };
  const binding = {
    spec: { matchResources: scope, policyName: 'ns-pods', validationActions: ['Deny'] },
  };
  change(policy, binding);
  vi.mocked(spawnCaptureAsync).mockImplementation(async (_command, args) => ({
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify(
      args[1] === 'namespace'
        ? { metadata: { labels: { 'asw/required-runtime-class': 'gvisor' } } }
        : args[1] === 'validatingadmissionpolicies'
          ? policy
          : binding
    ),
  }));
}
describe('workspace admission readiness', () => {
  it('requires the policy and Deny binding by default', async () => {
    responses();
    await assertWorkspaceAdmission();
    expect(spawnCaptureAsync).toHaveBeenCalledTimes(2);
    expect(spawnCaptureAsync).toHaveBeenCalledWith(
      'kubectl',
      ['get', 'validatingadmissionpolicies', 'ns-pods', '-o', 'json'],
      expect.anything()
    );
  });
  it('checks namespace runtime enforcement when required', async () => {
    responses();
    vi.stubEnv('K8S_REQUIRE_RUNTIME_CLASS', 'true');
    await assertWorkspaceAdmission();
    expect(spawnCaptureAsync).toHaveBeenCalledTimes(3);
  });
  it('allows only the explicit false opt-out and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('K8S_REQUIRE_ADMISSION_POLICY', 'false');
    await assertWorkspaceAdmission();
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('K8S_REQUIRE_ADMISSION_POLICY=false')
    );
  });
  it.each(['missing', 'invalid JSON'])('fails closed on %s resources', async (kind) => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      exitCode: kind === 'missing' ? 1 : 0,
      stderr: 'Forbidden',
      stdout: '',
    });
    await expect(assertWorkspaceAdmission()).rejects.toThrow();
  });
  it.each(['Ignore', 'Audit', 'wrong namespace', 'wrong policy', 'CEL warnings', 'empty'])(
    'refuses non-enforcing configuration: %s',
    async (kind) => {
      responses((policy, binding) => {
        if (kind === 'Ignore') {
          policy.spec.failurePolicy = 'Ignore';
        }
        if (kind === 'Audit') {
          binding.spec.validationActions = ['Audit'];
        }
        if (kind === 'wrong namespace') {
          binding.spec.matchResources.namespaceSelector.matchLabels['kubernetes.io/metadata.name'] =
            'foreign';
        }
        if (kind === 'wrong policy') {
          binding.spec.policyName = 'foreign';
        }
        if (kind === 'CEL warnings') {
          policy.status.typeChecking.expressionWarnings = [{}];
        }
        if (kind === 'empty') {
          policy.spec.validations = [];
        }
      });
      await expect(assertWorkspaceAdmission()).rejects.toThrow(/not an enforcing/);
    }
  );
  it('does not let a typo disable checking', async () => {
    vi.stubEnv('K8S_REQUIRE_ADMISSION_POLICY', 'flase');
    vi.mocked(spawnCaptureAsync).mockResolvedValue({ exitCode: 1, stderr: 'NotFound', stdout: '' });
    await expect(assertWorkspaceAdmission()).rejects.toThrow(/requires/);
  });
  it('refuses a namespace without the required runtime label', async () => {
    responses();
    vi.stubEnv('K8S_REQUIRE_RUNTIME_CLASS', 'true');
    vi.mocked(spawnCaptureAsync)
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          spec: {
            failurePolicy: 'Fail',
            matchConstraints: {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ns' } },
            },
            validations: [{}],
          },
        }),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          spec: {
            matchResources: {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ns' } },
            },
            policyName: 'ns-pods',
            validationActions: ['Deny'],
          },
        }),
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: '{"metadata":{}}' });
    await expect(assertWorkspaceAdmission()).rejects.toThrow(/required RuntimeClass/);
  });
});
