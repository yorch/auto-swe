import { describe, expect, it } from 'vitest';
import { buildDockerArgs } from './ephemeralContainer.js';

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
});
