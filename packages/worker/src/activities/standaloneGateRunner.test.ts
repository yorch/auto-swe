import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeWorkspace } = vi.hoisted(() => ({
  fakeWorkspace: {
    destroy: vi.fn(async () => {}),
    execCapture: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'ok' })),
  },
}));
const createWorkspace = vi.hoisted(() => vi.fn());
vi.mock('./workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace.js')>()),
  createWorkspace: (async (...args: unknown[]) => {
    createWorkspace(...args);
    return fakeWorkspace;
  }) as never,
}));

import { runGateStandalone } from './standaloneGateRunner.js';

const BASE = {
  authedRepoUrl: 'https://github.com/acme/r.git',
  branch: 'auto/T-1',
  defaultBranch: 'main',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runGateStandalone command resolution', () => {
  it('fails a gate that has no command instead of provisioning a workspace', async () => {
    const result = await runGateStandalone({ ...BASE, gate: 'runPerfBench' });
    expect(result.passed).toBe(false);
    expect(result.summary).toMatch(/no command configured/);
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only command as absent, not as a command that passed', async () => {
    // `sh -c '   '` exits 0 and would otherwise read as a green gate — including
    // on the eval `gate` scorer's path, which is the caller for this gate.
    for (const command of ['', '   ', '\t\n']) {
      const result = await runGateStandalone({ ...BASE, command, gate: 'runPerfBench' });
      expect(result.passed, `command ${JSON.stringify(command)}`).toBe(false);
      expect(result.summary).toMatch(/no command configured/);
    }
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('falls back to the built-in default when the command is whitespace-only', async () => {
    // Consistent with the workflow path, where a whitespace-only step override
    // falls back rather than disabling the gate.
    await runGateStandalone({ ...BASE, command: '  ', gate: 'runTests' });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(fakeWorkspace.execCapture).toHaveBeenCalledWith('yarn test', expect.anything());
  });

  it('runs a real command and reports its exit', async () => {
    fakeWorkspace.execCapture.mockResolvedValueOnce({
      exitCode: 1,
      stderr: 'boom',
      stdout: '',
    });
    const result = await runGateStandalone({ ...BASE, command: 'yarn test', gate: 'runTests' });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(fakeWorkspace.destroy).toHaveBeenCalledTimes(1);
  });
});
