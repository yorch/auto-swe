import { beforeEach, describe, expect, it, vi } from 'vitest';

// The backend is a fake: create() returns a handle, exec() answers from a
// queue, remove() records. No Docker daemon involved.
const { backend } = vi.hoisted(() => ({
  backend: {
    attach: vi.fn(),
    copyIn: vi.fn(async () => {}),
    copyOut: vi.fn(async () => {}),
    create: vi.fn(async () => ({ id: 'image-probe-1234', keeperPid: 7 })),
    exec: vi.fn(),
    pause: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    spawn: vi.fn(),
  },
}));

vi.mock('../lib/workspaceBackend/index.js', () => ({ workspaceBackend: () => backend }));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  DOCKER_HOST_ALIAS: 'host.docker.internal',
  resolveWorkspaceInfra: vi.fn(() => ({
    blockMetadata: false,
    cpus: 2,
    dns: [],
    image: 'node:24-alpine',
    memory: '4g',
    network: undefined,
    pidsLimit: 512,
    proxyHostAlias: undefined,
    stackImages: { go: 'registry.example/executor-go:1' },
  })),
}));

import { parseImageProbeOutput, probeExecutorImage } from './probeExecutorImage.js';

const ALL_OK_STDOUT = [
  'ASW|sh|ok|the probe is running under sh',
  'ASW|git|ok|git version 2.54.0',
  'ASW|tar|ok|tar (GNU tar) 1.35',
  'ASW|rg|ok|ripgrep 15.1.0',
  'ASW|exec-user|ok|node (uid 1000)',
  'ASW|workspace|ok|/workspace exists and is writable by the exec user',
].join('\n');

describe('parseImageProbeOutput', () => {
  it('is ok when every required check reports ok', () => {
    const r = parseImageProbeOutput(ALL_OK_STDOUT);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      'sh',
      'git',
      'tar',
      'rg',
      'exec-user',
      'workspace',
    ]);
    expect(r.checks.find((c) => c.name === 'exec-user')?.required).toBe(false);
  });

  it('fails when a required check reports fail', () => {
    const r = parseImageProbeOutput(ALL_OK_STDOUT.replace('ASW|git|ok', 'ASW|git|fail'));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'git')?.ok).toBe(false);
  });

  it('stays ok when optional rg reports fail', () => {
    const r = parseImageProbeOutput(ALL_OK_STDOUT.replace('ASW|rg|ok', 'ASW|rg|fail'));
    expect(r.ok).toBe(true);
    const rg = r.checks.find((c) => c.name === 'rg');
    expect(rg).toMatchObject({ ok: false, required: false });
  });

  it('synthesizes a required check the script never reported as failed', () => {
    const r = parseImageProbeOutput('ASW|sh|ok|up\nASW|git|ok|git 2.1\n');
    expect(r.ok).toBe(false);
    for (const name of ['tar', 'workspace']) {
      expect(r.checks.find((c) => c.name === name)).toMatchObject({ ok: false, required: true });
    }
  });

  it('ignores mangled and non-ASW lines', () => {
    const r = parseImageProbeOutput(
      `random noise\nASW|nope\nASW|sh|ok|up\nASW|git|maybe|x\n${ALL_OK_STDOUT.split('\n').slice(1).join('\n')}`
    );
    expect(r.ok).toBe(true);
    expect(r.checks.some((c) => c.name === 'nope')).toBe(false);
  });
});

describe('probeExecutorImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backend.create.mockResolvedValue({ id: 'image-probe-1234', keeperPid: 7 });
  });

  it('probes the stack image for a detected stack when no image is named', async () => {
    backend.exec
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: ALL_OK_STDOUT })
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: '' });
    const go = { components: [{ path: '', stacks: ['go'] }], evidence: ['go.mod'] };
    expect((await probeExecutorImage({ detectedStack: go })).image).toBe(
      'registry.example/executor-go:1'
    );
    // A stack with no configured image, no detection, and a named image each mean what they did.
    const py = { components: [{ path: '', stacks: ['python'] }], evidence: [] };
    backend.exec
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: ALL_OK_STDOUT })
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: '' });
    expect((await probeExecutorImage({ detectedStack: py })).image).toBe('node:24-alpine');
    backend.exec
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: ALL_OK_STDOUT })
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: '' });
    expect((await probeExecutorImage({ detectedStack: go, image: 'alpine:3.20' })).image).toBe(
      'alpine:3.20'
    );
  });

  it('runs the probe script and the keeper check, then removes the container', async () => {
    backend.exec
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: ALL_OK_STDOUT })
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: '' });
    const r = await probeExecutorImage({ image: 'alpine:3.20' });
    expect(r.ok).toBe(true);
    expect(backend.exec.mock.calls[1]?.[1]).toEqual(['sh', '-c', 'kill -0 7']);
    expect(r.checks.find((c) => c.name === 'keeper')).toMatchObject({ ok: true, required: true });
    expect(backend.remove).toHaveBeenCalledWith(expect.stringMatching(/^image-probe-/));
  });

  it('reports keeper as a required fail when kill -0 exits non-zero', async () => {
    backend.exec
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: ALL_OK_STDOUT })
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' });
    const r = await probeExecutorImage({ image: 'alpine:3.20' });
    expect(r.ok).toBe(false);
    const keeper = r.checks.find((c) => c.name === 'keeper');
    expect(keeper).toMatchObject({ ok: false, required: true });
    expect(keeper?.detail).toContain('kill -0 7 exited 1');
  });

  it('fails with an sh check when the probe script exits non-zero', async () => {
    backend.exec.mockResolvedValueOnce({ exitCode: 127, stderr: 'sh not found', stdout: '' });
    const r = await probeExecutorImage({ image: 'alpine:3.20' });
    expect(r.ok).toBe(false);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ name: 'sh', ok: false, required: true });
    expect(r.checks[0]?.detail).toContain('127');
    expect(backend.remove).toHaveBeenCalled();
  });

  it('returns a container-start check carrying the error when create() throws', async () => {
    backend.create.mockRejectedValueOnce(new Error('expected exactly one child of PID 1, found 0'));
    const r = await probeExecutorImage({ image: 'alpine:3.20' });
    expect(r.ok).toBe(false);
    expect(r.checks[0]).toMatchObject({ name: 'container-start', ok: false });
    expect(r.checks[0]?.detail).toContain('expected exactly one child of PID 1, found 0');
    expect(backend.remove).toHaveBeenCalled();
  });

  it('still removes the container when the probe exec throws', async () => {
    backend.exec.mockRejectedValueOnce(new Error('exec blew up'));
    const r = await probeExecutorImage({ image: 'alpine:3.20' });
    expect(r.ok).toBe(false);
    expect(backend.remove).toHaveBeenCalledWith(expect.stringMatching(/^image-probe-/));
  });

  it('throws for a malformed image ref and starts nothing', async () => {
    await expect(probeExecutorImage({ image: 'bad;;image' })).rejects.toThrow(
      'Invalid Docker image name'
    );
    expect(backend.create).not.toHaveBeenCalled();
  });
});
