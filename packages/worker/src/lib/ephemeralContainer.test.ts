import { describe, expect, it } from 'vitest';
import { buildDockerArgs, buildSidecarDockerArgs } from './ephemeralContainer.js';

const BASE = {
  command: 'echo hello',
  image: 'alpine:latest',
  workspaceMount: 'shellvol-abc',
};

describe('buildDockerArgs', () => {
  it('emits the locked-down default flag set', () => {
    const args = buildDockerArgs(BASE, 'shellstep-deadbeef');
    expect(args).toContain('--rm');
    expect(args).toContain('--network=none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--pids-limit=256');
    expect(args).toContain('--tmpfs=/tmp:size=64m,mode=1777');
    expect(args).toContain('--memory=512m');
    expect(args).toContain('--cpus=1');
  });

  it('passes through workspace mount, image, and command via -- separator', () => {
    const args = buildDockerArgs(BASE, 'shellstep-deadbeef');
    const mountIdx = args.indexOf('-v');
    expect(args[mountIdx + 1]).toBe('shellvol-abc:/workspace:rw');
    const sep = args.indexOf('--');
    expect(args[sep + 1]).toBe('alpine:latest');
    expect(args[sep + 2]).toBe('sh');
    expect(args[sep + 3]).toBe('-c');
    expect(args[sep + 4]).toBe('echo hello');
  });

  it('injects -e KEY=VALUE for env entries (container-contract JSON input)', () => {
    const args = buildDockerArgs({ ...BASE, env: { CONTAINER_STEP_INPUT: '{"q":1}' } }, 'name');
    const i = args.indexOf('-e');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('CONTAINER_STEP_INPUT={"q":1}');
    // env args precede the `--` image separator
    expect(i).toBeLessThan(args.indexOf('--'));
  });

  it('rejects an invalid env var name', () => {
    expect(() => buildDockerArgs({ ...BASE, env: { 'bad-name': 'x' } }, 'name')).toThrow(
      /environment variable name/
    );
  });

  it('switches network mode to bridge when egress is requested', () => {
    const args = buildDockerArgs({ ...BASE, network: 'egress' }, 'name');
    expect(args).toContain('--network=bridge');
    expect(args).not.toContain('--network=none');
  });

  it('honors custom memory and cpu caps', () => {
    const args = buildDockerArgs({ ...BASE, cpus: 2, memory: '1g' }, 'name');
    expect(args).toContain('--memory=1g');
    expect(args).toContain('--cpus=2');
  });

  it('rejects images that could escape into docker flag space', () => {
    expect(() => buildDockerArgs({ ...BASE, image: '--privileged' }, 'name')).toThrow(
      /Invalid Docker image name/
    );
    expect(() => buildDockerArgs({ ...BASE, image: '-v /:/host' }, 'name')).toThrow();
  });

  it('rejects mount sources that look like docker flags', () => {
    expect(() => buildDockerArgs({ ...BASE, workspaceMount: '-rm' }, 'name')).toThrow(
      /Invalid workspace mount source/
    );
    expect(() => buildDockerArgs({ ...BASE, workspaceMount: 'vol with space' }, 'name')).toThrow();
  });

  it('rejects malformed memory literals', () => {
    expect(() => buildDockerArgs({ ...BASE, memory: 'one-gig' }, 'name')).toThrow(
      /Invalid memory literal/
    );
  });

  it('rejects out-of-range cpu values', () => {
    expect(() => buildDockerArgs({ ...BASE, cpus: 99 }, 'name')).toThrow(/Invalid cpus/);
    expect(() => buildDockerArgs({ ...BASE, cpus: 0 }, 'name')).toThrow(/Invalid cpus/);
  });

  it('honors custom workdir', () => {
    const args = buildDockerArgs({ ...BASE, workdir: '/workspace/repo' }, 'name');
    const wIdx = args.indexOf('-w');
    expect(args[wIdx + 1]).toBe('/workspace/repo');
  });

  it('rejects a negative or non-finite cpus value', () => {
    expect(() => buildDockerArgs({ ...BASE, cpus: -1 }, 'name')).toThrow(/Invalid cpus/);
    expect(() => buildDockerArgs({ ...BASE, cpus: Number.NaN }, 'name')).toThrow(/Invalid cpus/);
    expect(() => buildDockerArgs({ ...BASE, cpus: Number.POSITIVE_INFINITY }, 'name')).toThrow(
      /Invalid cpus/
    );
  });

  it('accepts the cpus upper boundary of 8', () => {
    const args = buildDockerArgs({ ...BASE, cpus: 8 }, 'name');
    expect(args).toContain('--cpus=8');
  });

  it('rejects an image name that starts with a separator character', () => {
    expect(() => buildDockerArgs({ ...BASE, image: '.evil/image' }, 'name')).toThrow(
      /Invalid Docker image name/
    );
  });

  it('adds --dns=127.0.0.2 for egress mode with a non-empty allowlist', () => {
    const args = buildDockerArgs(
      { ...BASE, egressAllowlist: ['registry.npmjs.org'], network: 'egress' },
      'name'
    );
    expect(args).toContain('--dns=127.0.0.2');
    expect(args).toContain('--network=bridge');
  });

  it('omits --dns when egress mode has no allowlist entries', () => {
    const args = buildDockerArgs({ ...BASE, egressAllowlist: [], network: 'egress' }, 'name');
    expect(args.some((a) => a.startsWith('--dns='))).toBe(false);
  });

  it('ignores egressAllowlist when network is the none default (no --dns leak)', () => {
    const args = buildDockerArgs(
      { ...BASE, egressAllowlist: ['registry.npmjs.org'], network: 'none' },
      'name'
    );
    expect(args.some((a) => a.startsWith('--dns='))).toBe(false);
    expect(args).toContain('--network=none');
  });

  it('accepts an absolute-path workspace mount', () => {
    const args = buildDockerArgs({ ...BASE, workspaceMount: '/data/workspaces/w1' }, 'name');
    const mountIdx = args.indexOf('-v');
    expect(args[mountIdx + 1]).toBe('/data/workspaces/w1:/workspace:rw');
  });
});

describe('buildSidecarDockerArgs', () => {
  const SIDE = { image: 'node:24-alpine', port: 8080, workspaceMount: 'cstep-abc' };

  it('runs detached with a loopback-only published port and the full lockdown', () => {
    const args = buildSidecarDockerArgs(SIDE, 'sidecar-abc');
    expect(args).toContain('-d');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--read-only');
    const pIdx = args.indexOf('-p');
    expect(args[pIdx + 1]).toBe('127.0.0.1::8080/tcp');
  });

  it('omits sh -c when no command is given (image entrypoint serves HTTP)', () => {
    const args = buildSidecarDockerArgs(SIDE, 'sidecar-abc');
    const sep = args.indexOf('--');
    expect(args[sep + 1]).toBe('node:24-alpine');
    expect(args[sep + 2]).toBeUndefined();
  });

  it('appends sh -c <command> when a command override is given', () => {
    const args = buildSidecarDockerArgs({ ...SIDE, command: 'node server.js' }, 'sidecar-abc');
    const sep = args.indexOf('--');
    expect(args.slice(sep + 1)).toEqual(['node:24-alpine', 'sh', '-c', 'node server.js']);
  });

  it('rejects an out-of-range port', () => {
    expect(() => buildSidecarDockerArgs({ ...SIDE, port: 0 }, 'name')).toThrow(
      /Invalid sidecar port/
    );
    expect(() => buildSidecarDockerArgs({ ...SIDE, port: 70000 }, 'name')).toThrow(
      /Invalid sidecar port/
    );
  });

  it('rejects a non-integer port', () => {
    expect(() => buildSidecarDockerArgs({ ...SIDE, port: 8080.5 }, 'name')).toThrow(
      /Invalid sidecar port/
    );
  });

  it('applies the full lockdown flag set shared with buildDockerArgs', () => {
    const args = buildSidecarDockerArgs(SIDE, 'sidecar-abc');
    expect(args).toContain('--network=none');
    expect(args).toContain('--memory=512m');
    expect(args).toContain('--cpus=1');
    expect(args).toContain('--pids-limit=256');
    expect(args).toContain('--tmpfs=/tmp:size=64m,mode=1777');
    expect(args).toContain('--security-opt=no-new-privileges');
  });

  it('switches to bridge networking and injects --dns for egress with an allowlist', () => {
    const args = buildSidecarDockerArgs(
      { ...SIDE, egressAllowlist: ['registry.npmjs.org'], network: 'egress' },
      'name'
    );
    expect(args).toContain('--network=bridge');
    expect(args).toContain('--dns=127.0.0.2');
  });

  it('rejects an invalid Docker image name (validation shared with buildDockerArgs)', () => {
    expect(() => buildSidecarDockerArgs({ ...SIDE, image: '--privileged' }, 'name')).toThrow(
      /Invalid Docker image name/
    );
  });

  it('rejects an invalid workspace mount source (validation shared with buildDockerArgs)', () => {
    expect(() => buildSidecarDockerArgs({ ...SIDE, workspaceMount: '-rm' }, 'name')).toThrow(
      /Invalid workspace mount source/
    );
  });

  it('honors custom memory and cpu caps', () => {
    const args = buildSidecarDockerArgs({ ...SIDE, cpus: 4, memory: '2g' }, 'name');
    expect(args).toContain('--memory=2g');
    expect(args).toContain('--cpus=4');
  });
});
