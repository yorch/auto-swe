import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceBackend } from '../types.js';
import { assertNetworkPolicyEnforced, wasBlocked } from './ready.js';

describe('wasBlocked', () => {
  it.each([
    ['wget: download timed out\nasw_exit=1', true],
    ['wget: can’t connect to remote host: Network unreachable\nasw_exit=1', true],
    ['wget: can’t connect to remote host: No route to host\nasw_exit=1', true],
    ['wget: can’t connect to remote host: Operation not permitted\nasw_exit=1', true],
  ])('treats %j as a dropped connection', (output, blocked) => {
    expect(wasBlocked(output)).toBe(blocked);
  });

  it.each([
    ['asw_exit=0'],
    ['wget: server returned error: HTTP/1.1 404 Not Found\nasw_exit=8'],
    ['wget: can’t connect to remote host: Connection refused\nasw_exit=1'],
    ['wget: error getting response\nasw_exit=1'],
    [''],
  ])('treats %j as reached (a refusal is an answer, silence is not proof)', (output) => {
    expect(wasBlocked(output)).toBe(false);
  });

  it('does not let a timeout in a successful run mask the exit status', () => {
    expect(wasBlocked('request timed out earlier\nasw_exit=0')).toBe(false);
  });
});

function fakeBackend(outputFor: (script: string) => string) {
  const exec = vi.fn(async (_h: unknown, argv: string[]) => ({
    exitCode: 0,
    stderr: '',
    stdout: outputFor(argv.join(' ')),
  }));
  const create = vi.fn(async (spec: { name: string }) => ({ id: spec.name, keeperPid: 7 }));
  const remove = vi.fn(async () => undefined);
  return { backend: { create, exec, remove } as unknown as WorkspaceBackend, create, exec, remove };
}

const BLOCKED = 'wget: download timed out\nasw_exit=1';

describe('assertNetworkPolicyEnforced', () => {
  it('passes when every probe is dropped, and removes the probe pod', async () => {
    const { backend, exec, remove } = fakeBackend(() => BLOCKED);
    await expect(
      assertNetworkPolicyEnforced({
        backend,
        env: { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' },
      })
    ).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
    const scripts = exec.mock.calls.map((c) => c[1].join(' '));
    expect(scripts[0]).toContain('169.254.169.254:80');
    expect(scripts[1]).toContain('10.96.0.1:443');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('refuses when the metadata endpoint answers, naming it', async () => {
    const { backend, remove } = fakeBackend((script) =>
      script.includes('169.254.169.254') ? 'asw_exit=0' : BLOCKED
    );
    await expect(
      assertNetworkPolicyEnforced({ backend, env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' } })
    ).rejects.toThrow(/NetworkPolicy is not enforced.*cloud metadata endpoint/s);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('refuses when the cluster API answers', async () => {
    const { backend } = fakeBackend((script) =>
      script.includes('10.96.0.1') ? 'asw_exit=8' : BLOCKED
    );
    await expect(
      assertNetworkPolicyEnforced({ backend, env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' } })
    ).rejects.toThrow(/cluster API address/);
  });

  it('probes only the metadata endpoint when the worker is outside the cluster', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { backend, exec } = fakeBackend(() => BLOCKED);
    await assertNetworkPolicyEnforced({ backend, env: {} });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('KUBERNETES_SERVICE_HOST'));
    warn.mockRestore();
  });

  it('cleans up a probe pod that failed to start, and reports why', async () => {
    const { backend, create, remove } = fakeBackend(() => BLOCKED);
    create.mockRejectedValueOnce(new Error('image pull failed'));
    await expect(assertNetworkPolicyEnforced({ backend, env: {} })).rejects.toThrow(
      'image pull failed'
    );
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('removes the probe pod even when an exec throws', async () => {
    const { backend, exec, remove } = fakeBackend(() => BLOCKED);
    exec.mockRejectedValueOnce(new Error('exec failed'));
    await expect(assertNetworkPolicyEnforced({ backend, env: {} })).rejects.toThrow('exec failed');
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
