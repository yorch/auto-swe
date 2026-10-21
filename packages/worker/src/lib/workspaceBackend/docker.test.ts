import { DOCKER_HOST_ALIAS } from '@auto-swe/shared/lib/systemConfig';
import { describe, expect, it } from 'vitest';
import { dockerWorkspaceBackend, ephemeralArgs } from './docker.js';

describe('ephemeralArgs', () => {
  it('runs with no network unless the spec asks for egress', () => {
    expect(ephemeralArgs({ image: 'img' }, false)).toContain('--network=none');
    expect(ephemeralArgs({ image: 'img', network: 'none' }, false)).toContain('--network=none');
    expect(ephemeralArgs({ image: 'img', network: 'egress' }, false)).toContain('--network=bridge');
  });

  it('maps reachWorker to the host-gateway alias, after the resolved hosts', () => {
    const args = ephemeralArgs(
      { addHosts: ['example.com:203.0.113.7'], image: 'img', reachWorker: true },
      false
    );
    const hosts = args.filter((a) => a.startsWith('--add-host='));
    expect(hosts).toEqual([
      '--add-host=example.com:203.0.113.7',
      `--add-host=${DOCKER_HOST_ALIAS}:host-gateway`,
    ]);
  });

  it('adds no worker alias when the container does not need the worker', () => {
    const args = ephemeralArgs({ image: 'img' }, false);
    expect(args.some((a) => a.startsWith('--add-host='))).toBe(false);
  });
});

describe('canReachWorkerProxy', () => {
  it('accepts only a proxy advertised at the Docker host alias', () => {
    const backend = dockerWorkspaceBackend();
    expect(backend.canReachWorkerProxy(`http://${DOCKER_HOST_ALIAS}:9000`)).toBe(true);
    expect(backend.canReachWorkerProxy('http://worker.internal:9000')).toBe(false);
  });
});
