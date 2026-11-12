import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execShellAsync, spawnCaptureAsync } from '../execUtils.js';
import {
  baselineRules,
  dockerWorkspaceBackend,
  ephemeralArgs,
  ephemeralNetworkHolderArgs,
} from './docker.js';
import type { EphemeralContainerSpec } from './types.js';

vi.mock('../execUtils.js', async (original) => ({
  ...(await original<typeof import('../execUtils.js')>()),
  execShellAsync: vi.fn(),
  spawnCaptureAsync: vi.fn(),
}));

const spec: EphemeralContainerSpec & { name: string } = {
  argv: ['sh', '-c', 'echo author'],
  image: 'author:1',
  name: 'step-test',
  network: 'egress',
  secretEnv: { HTTP_PROXY: 'http://token@host.docker.internal:8792' },
  volumes: [{ source: 'step-volume', target: '/workspace' }],
};

describe('ephemeral runtime arguments', () => {
  it('selects the runtime for foreground/detached authors, sidecars and network holders', () => {
    vi.stubEnv('WORKSPACE_RUNTIME', 'runsc-host');
    expect(ephemeralArgs(spec, false, 'holder')).toContain('--runtime=runsc-host');
    expect(ephemeralArgs(spec, true, 'holder')).toContain('--runtime=runsc-host');
    expect(ephemeralNetworkHolderArgs(spec, 'holder')).toContain('--runtime=runsc-host');
    expect(ephemeralArgs({ image: 'img', network: 'none' }, false)).toContain(
      '--runtime=runsc-host'
    );
  });
});
const result = { exitCode: 7, stderr: 'author-error\n', stdout: 'author-output\n' };
const events: string[] = [];
let holder = '';
let allows: Parameters<typeof baselineRules>[0] = [];
let cidrs: string[] = [];

function report() {
  const rules = baselineRules(
    allows,
    cidrs,
    process.env.WORKSPACE_BLOCK_PRIVATE_EGRESS !== 'false',
    process.env.WORKSPACE_BLOCK_METADATA !== 'false'
  );
  return [
    'v4:',
    '-P OUTPUT ACCEPT',
    '-A OUTPUT -j ASW_BASELINE',
    ...rules.v4.map((r) => `-A ASW_BASELINE ${r}`),
    'v6:',
    '-P OUTPUT ACCEPT',
    '-A OUTPUT -j ASW_BASELINE',
    ...rules.v6.map((r) => `-A ASW_BASELINE ${r}`),
    'v6disabled=0',
  ].join('\n');
}

beforeEach(() => {
  vi.resetAllMocks();
  events.length = 0;
  allows = [];
  cidrs = [];
  for (const key of [
    'HARNESS_MODEL_PROXY_PORT',
    'REGISTRY_PROXY_PORT',
    'EGRESS_PROXY_PORT',
    'WORKSPACE_PRIVATE_EGRESS_ALLOW',
  ]) {
    vi.stubEnv(key, '');
  }
  vi.stubEnv('WORKSPACE_DNS', '1.1.1.1');
  vi.stubEnv('WORKSPACE_BLOCK_PRIVATE_EGRESS', 'true');
  vi.stubEnv('WORKSPACE_BLOCK_METADATA', 'true');
  vi.mocked(spawnCaptureAsync).mockImplementation(async (_bin, args) => {
    if (args[0] === 'run') {
      if (args.includes('--entrypoint=sleep')) {
        holder = args[args.indexOf('--name') + 1];
        events.push('holder');
        return { exitCode: 0, stderr: '', stdout: 'holder-id' };
      }
      events.push('step');
      return result;
    }
    if (args[0] === 'ps') {
      return { exitCode: 0, stderr: '', stdout: 'abc123' };
    }
    if (args[0] === 'rm') {
      events.push('holder-removed');
    }
    return {
      exitCode: 0,
      stderr: '',
      stdout: args[0] === 'inspect' ? '[]' : '127.0.0.1 localhost\n',
    };
  });
  vi.mocked(execShellAsync).mockImplementation(async (cmd) => {
    if (cmd.includes('--cap-add=NET_ADMIN')) {
      events.push('baseline');
      return report();
    }
    if (cmd.startsWith('docker rm')) {
      events.push('step-removed');
    }
    if (cmd.startsWith('docker inspect')) {
      return `container:${holder}`;
    }
    if (cmd.startsWith('docker port')) {
      return '127.0.0.1:49162';
    }
    return '';
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('ephemeral network holder', () => {
  describe('restricted proxy lock', () => {
    const locked =
      'v4:\n-P OUTPUT DROP\n-P INPUT DROP\nv6:\n-P OUTPUT DROP\n-P INPUT DROP\nv6disabled=0\n';
    beforeEach(() => {
      vi.stubEnv('EGRESS_PROXY_PORT', '8792');
      vi.stubEnv('REGISTRY_PROXY_PORT', '8791');
      vi.stubEnv('HARNESS_MODEL_PROXY_PORT', '8790');
      allows = [{ ip: '172.17.0.1', port: 8792 }];
      const spawn = vi.mocked(spawnCaptureAsync).getMockImplementation();
      const exec = vi.mocked(execShellAsync).getMockImplementation();
      vi.mocked(spawnCaptureAsync).mockImplementation(async (bin, args, opts) => {
        if (args[0] === 'inspect') {
          return { exitCode: 0, stderr: '', stdout: '["host.docker.internal:host-gateway"]' };
        }
        if (args.includes('cat')) {
          return {
            exitCode: 0,
            stderr: '',
            stdout: '127.0.0.1 localhost\n172.17.0.1 host.docker.internal\n',
          };
        }
        return spawn
          ? spawn(bin, args, opts)
          : { exitCode: 1, stderr: 'missing fixture', stdout: '' };
      });
      vi.mocked(execShellAsync).mockImplementation(async (cmd, opts) => {
        if (cmd.includes('iptables -P OUTPUT DROP')) {
          events.push('lock');
          return locked;
        }
        return exec ? exec(cmd, opts) : '';
      });
    });
    const restricted = {
      ...spec,
      dns: [],
      egressPolicy: 'restricted' as const,
      reachWorker: true,
    };

    it('locks only wired proxy ports after the baseline, before author code, preserving result and cleanup', async () => {
      const output = await dockerWorkspaceBackend().runEphemeral(restricted, {
        heartbeatLabel: 'test',
      });
      expect(output).toEqual(result);
      expect(events).toEqual([
        'holder',
        'baseline',
        'lock',
        'step',
        'holder-removed',
        'step-removed',
      ]);
      const script =
        vi
          .mocked(execShellAsync)
          .mock.calls.find(([cmd]) => cmd.includes('iptables -P OUTPUT DROP'))?.[0] ?? '';
      expect(script).toContain(`--network container:${holder}`);
      expect(script).toContain('8792');
      expect(script).not.toContain('8791');
      expect(script).not.toContain('8790');
      expect(script).not.toContain('--sport');
    });

    it('admits a wired registry, and only established sidecar replies to the worker gateway', async () => {
      allows.unshift({ ip: '172.17.0.1', port: 8791 });
      await dockerWorkspaceBackend().startDetached(
        {
          ...restricted,
          env: ['NPM_CONFIG_REGISTRY=http://host.docker.internal:8791/npm/'],
          publishPort: 8080,
        },
        { heartbeatLabel: 'test' }
      );
      const script =
        vi
          .mocked(execShellAsync)
          .mock.calls.find(([cmd]) => cmd.includes('iptables -P OUTPUT DROP'))?.[0] ?? '';
      expect(script).toContain('8791');
      expect(script).toContain('--sport 8080 -m conntrack --ctstate ESTABLISHED -j ACCEPT');
      expect(script).toContain('--dport 8080 -m conntrack --ctstate NEW -j ACCEPT');
      expect(script).toContain('172.17.0.1');
      expect(script).not.toContain('8790');
      expect(events.indexOf('lock')).toBeLessThan(events.indexOf('step'));
      await dockerWorkspaceBackend().remove(restricted.name);
    });

    it.each(['foreground', 'detached'])(
      'refuses bad kernel read-back before starting a %s author',
      async (mode) => {
        const exec = vi.mocked(execShellAsync).getMockImplementation();
        vi.mocked(execShellAsync).mockImplementation(async (cmd, opts) =>
          cmd.includes('iptables -P OUTPUT DROP')
            ? 'v4:\n-P OUTPUT ACCEPT'
            : exec
              ? exec(cmd, opts)
              : ''
        );
        const backend = dockerWorkspaceBackend();
        await expect(
          mode === 'foreground'
            ? backend.runEphemeral(restricted, {})
            : backend.startDetached(restricted, {})
        ).rejects.toMatchObject({ type: 'EGRESS_POLICY_UNENFORCEABLE' });
        expect(events).not.toContain('step');
        expect(events).toContain('holder-removed');
        expect(events).toContain('step-removed');
      }
    );

    it('refuses an unwired proxy before author code runs', async () => {
      allows = [];
      await expect(
        dockerWorkspaceBackend().runEphemeral({ ...restricted, secretEnv: {} }, {})
      ).rejects.toMatchObject({ type: 'EGRESS_POLICY_UNENFORCEABLE' });
      expect(events).not.toContain('step');
      expect(events).toContain('holder-removed');
    });
  });
  it('moves DNS, host pins and sidecar publishing to a locked-down labeled holder, without author env or mounts', () => {
    const sidecar = {
      ...spec,
      addHosts: ['allowed.example:1.1.1.1'],
      dns: ['127.0.0.2'],
      publishPort: 8080,
      reachWorker: true,
    };
    const args = ephemeralNetworkHolderArgs(
      sidecar as typeof spec & { name: string },
      'holder-test'
    );
    expect(args).toEqual(
      expect.arrayContaining([
        '--network=bridge',
        '--dns=127.0.0.2',
        '--add-host=allowed.example:1.1.1.1',
        '--add-host=host.docker.internal:host-gateway',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        'auto-swe.workspace=true',
        'asw.workspace=step-test',
        '127.0.0.1::8080/tcp',
      ])
    );
    expect(args).not.toContain('HTTP_PROXY');
    expect(args).not.toContain('-v');
    expect(args).not.toContain('echo author');
    const author = ephemeralArgs(sidecar, true, 'holder-test');
    expect(author).toContain('--network=container:holder-test');
    expect(author).toContain('step-volume:/workspace:rw');
    expect(author).toContain('HTTP_PROXY');
    expect(author.some((arg) => arg.startsWith('--dns=') || arg.startsWith('--add-host='))).toBe(
      false
    );
    expect(author).not.toContain('-p');
  });

  it('verifies before author code and preserves output, nonzero exit, timeout and stdout callback, then removes the holder', async () => {
    const onStdoutLine = vi.fn();
    expect(
      await dockerWorkspaceBackend().runEphemeral(spec, {
        heartbeatLabel: 'test',
        onStdoutLine,
        timeoutMs: 1234,
      })
    ).toEqual(result);
    expect(events).toEqual(['holder', 'baseline', 'step', 'holder-removed', 'step-removed']);
    expect(spawnCaptureAsync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([`--network=container:${holder}`]),
      expect.objectContaining({ env: spec.secretEnv, onStdoutLine, timeoutMs: 1234 })
    );
  });

  it.each(['holder', 'baseline', 'step'])(
    'fails closed and cleans up on %s failure',
    async (stage) => {
      if (stage === 'baseline') {
        vi.mocked(execShellAsync).mockRejectedValueOnce(new Error('helper failed'));
      } else {
        const original = vi.mocked(spawnCaptureAsync).getMockImplementation();
        if (!original) {
          throw new Error('missing spawn fixture');
        }
        vi.mocked(spawnCaptureAsync).mockImplementation(async (bin, args, opts) => {
          if (args[0] === 'run' && args.includes('--entrypoint=sleep') === (stage === 'holder')) {
            throw new Error(`${stage} failed`);
          }
          return original(bin, args, opts);
        });
      }
      await expect(
        dockerWorkspaceBackend().runEphemeral(spec, { heartbeatLabel: 'test' })
      ).rejects.toThrow(`${stage === 'baseline' ? 'helper' : stage} failed`);
      if (stage !== 'step') {
        expect(events).not.toContain('step');
      }
      expect(events).toContain('holder-removed');
      expect(events).toContain('step-removed');
    }
  );

  it('rejects invalid kernel read-back without running author code', async () => {
    vi.mocked(execShellAsync).mockResolvedValueOnce('v4:\n-P OUTPUT ACCEPT');
    await expect(
      dockerWorkspaceBackend().runEphemeral(spec, { heartbeatLabel: 'test' })
    ).rejects.toThrow();
    expect(events).not.toContain('step');
    expect(events).toContain('holder-removed');
  });

  it('leaves network none unchanged, without a holder or helper', async () => {
    await dockerWorkspaceBackend().runEphemeral(
      { ...spec, network: 'none' },
      { heartbeatLabel: 'test' }
    );
    expect(events).toEqual(['step']);
    expect(execShellAsync).not.toHaveBeenCalled();
  });

  it.each(['metadata-only', 'disabled'])('honors %s switches', async (mode) => {
    vi.stubEnv('WORKSPACE_BLOCK_PRIVATE_EGRESS', 'false');
    if (mode === 'disabled') {
      vi.stubEnv('WORKSPACE_BLOCK_METADATA', 'false');
    }
    await dockerWorkspaceBackend().runEphemeral(spec, { heartbeatLabel: 'test' });
    expect(events.includes('baseline')).toBe(mode !== 'disabled');
  });

  it('admits configured private DNS, operator CIDRs and only a wired proxy, not the model proxy', async () => {
    vi.stubEnv('WORKSPACE_DNS', '10.0.0.53');
    vi.stubEnv('WORKSPACE_PRIVATE_EGRESS_ALLOW', '10.1.0.0/16');
    vi.stubEnv('REGISTRY_PROXY_PORT', '8791');
    vi.stubEnv('REGISTRY_PROXY_URL', 'http://10.0.0.5:8791');
    vi.stubEnv('HARNESS_MODEL_PROXY_PORT', '8790');
    vi.stubEnv('HARNESS_MODEL_PROXY_URL', 'http://missing.internal:8790');
    allows = [
      { ip: '10.0.0.5', port: 8791 },
      { ip: '10.0.0.53', port: 53, protocol: 'udp' },
      { ip: '10.0.0.53', port: 53, protocol: 'tcp' },
    ];
    cidrs = ['10.1.0.0/16'];
    await dockerWorkspaceBackend().runEphemeral(
      { ...spec, env: ['NPM_CONFIG_REGISTRY=http://10.0.0.5:8791/npm'], reachWorker: true },
      { heartbeatLabel: 'test' }
    );
    expect(events).toContain('step');
  });

  it('keeps a successful detached sidecar holder until removal, and publishes through that holder', async () => {
    const original = vi.mocked(spawnCaptureAsync).getMockImplementation();
    if (!original) {
      throw new Error('missing spawn fixture');
    }
    vi.mocked(spawnCaptureAsync).mockImplementation(async (bin, args, opts) =>
      args[0] === 'run' && !args.includes('--entrypoint=sleep')
        ? { exitCode: 0, stderr: '', stdout: 'author-id' }
        : original(bin, args, opts)
    );
    await dockerWorkspaceBackend().startDetached(
      { ...spec, publishPort: 8080 },
      { heartbeatLabel: 'test' }
    );
    expect(events).toEqual(['holder', 'baseline']);
    expect(await dockerWorkspaceBackend().sidecarBaseUrl(spec.name, 8080)).toBe(
      'http://127.0.0.1:49162'
    );
    expect(execShellAsync).toHaveBeenCalledWith(
      `docker port '${holder}' 8080/tcp`,
      expect.anything()
    );
    await dockerWorkspaceBackend().remove(spec.name);
    expect(events).toContain('holder-removed');
  });

  it('removes an unnamed detached holder when teardown uses the returned Docker ID', async () => {
    const original = vi.mocked(spawnCaptureAsync).getMockImplementation();
    if (!original) {
      throw new Error('missing spawn fixture');
    }
    const id = 'a'.repeat(64);
    let name = '';
    vi.mocked(spawnCaptureAsync).mockImplementation(async (bin, args, opts) => {
      if (args[0] === 'run' && !args.includes('--entrypoint=sleep')) {
        name = args[args.indexOf('--name') + 1];
        return { exitCode: 0, stderr: '', stdout: id };
      }
      if (args[0] === 'inspect' && args.includes('{{.Name}}')) {
        return { exitCode: 0, stderr: '', stdout: `/${name}\n` };
      }
      return original(bin, args, opts);
    });
    const backend = dockerWorkspaceBackend();
    await backend.startDetached({ ...spec, name: undefined }, { heartbeatLabel: 'test' });
    await backend.remove(id);
    expect(name).toMatch(/^sidecar-/);
    expect(spawnCaptureAsync).toHaveBeenCalledWith(
      'docker',
      ['ps', '-aq', '--filter', `label=asw.workspace=${name}`],
      expect.anything()
    );
    expect(events).toContain('holder-removed');
  });

  it('removes the holder when a detached author container fails to start', async () => {
    expect(
      (await dockerWorkspaceBackend().startDetached(spec, { heartbeatLabel: 'test' })).exitCode
    ).toBe(7);
    expect(events).toContain('holder-removed');
  });
});
