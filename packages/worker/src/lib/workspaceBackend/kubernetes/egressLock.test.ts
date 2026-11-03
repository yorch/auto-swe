import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEgressAllowPolicy,
  type EgressLockDeps,
  isForbiddenAllowAddress,
  labelBlockedArgs,
  lockPodEgress,
  probeScript,
  resolveAllow,
} from './egressLock.js';

const UID = '0b1c2d3e-0000-4000-8000-000000000001';
const ok = (stdout = '') => ({ exitCode: 0, stderr: '', stdout });
const BLOCKED = ok('asw_probe=closed\n');
const REACHED = ok('asw_probe=open\n');
const NOTOOL = ok('asw_probe=notool\n');

function deps(over: Partial<EgressLockDeps> = {}) {
  const kubectl = vi.fn(async (args: string[], _stdin?: string) =>
    args[0] === 'get' ? ok(UID) : ok()
  );
  // Reachable before the label, unreachable once it has been applied.
  const probe = vi.fn(async (_script: string) =>
    kubectl.mock.calls.some((c) => c[0][0] === 'label') ? BLOCKED : REACHED
  );
  const d: EgressLockDeps = {
    kubectl,
    lookup: async () => ['140.82.112.3'],
    namespace: 'ns',
    pollIntervalMs: 0,
    probe,
    sleep: async () => undefined,
    verifyAttempts: 3,
    ...over,
  };
  return { d, kubectl, probe };
}

describe('resolveAllow', () => {
  it('resolves names, keeps literals and ports', async () => {
    const out = await resolveAllow(
      [{ host: 'git.example.com', port: 443 }, { host: '10.1.2.3' }],
      async () => ['1.2.3.4', '5.6.7.8']
    );
    expect(out).toEqual([
      { ip: '1.2.3.4', port: 443 },
      { ip: '5.6.7.8', port: 443 },
      { ip: '10.1.2.3' },
    ]);
  });

  it('refuses a name that resolves to a metadata, loopback or link-local address', async () => {
    for (const ip of [
      '169.254.169.254',
      '127.0.0.1',
      '0.0.0.0',
      'fe80::1',
      '::1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '169.254.0.1',
      '169.254.170.2',
      '127.255.255.254',
      '0.1.2.3',
      '224.0.0.1',
      '239.255.255.250',
      '255.255.255.255',
      'fd00:ec2::254',
      'FD00:EC2:0:0:0:0:0:254',
      '100.100.100.200',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '64:ff9b::7f00:1',
      '::169.254.169.254',
      '2002:a9fe:a9fe::1',
      '::0',
      '0:0:0:0:0:0:0:1',
      'ff02::1',
      'fe80::1%eth0',
      'febf::1',
      'not-an-address',
    ]) {
      await expect(resolveAllow([{ host: 'x.example.com' }], async () => [ip])).rejects.toThrow(
        /refused address/
      );
    }
    for (const ip of [
      '140.82.112.3',
      '100.100.100.201',
      '10.1.2.3',
      '2001:db8::1',
      '64:ff9b::8c52:7003',
      '::ffff:140.82.112.3',
      'fd00:ec2::255',
    ]) {
      expect(isForbiddenAllowAddress(ip), ip).toBe(false);
    }
  });

  it('fails when a name resolves to nothing, or the lookup fails', async () => {
    await expect(resolveAllow([{ host: 'x.example.com' }], async () => [])).rejects.toThrow(
      /no address/
    );
    await expect(
      resolveAllow([{ host: 'x.example.com' }], async () => {
        throw new Error('ENOTFOUND');
      })
    ).rejects.toThrow('ENOTFOUND');
  });
});

describe('buildEgressAllowPolicy', () => {
  it('selects only the blocked pod, is owned by it, and admits /32 and /128 blocks', () => {
    const policy = buildEgressAllowPolicy('workspace-a', UID, 'ns', [
      { ip: '1.2.3.4', port: 443 },
      { ip: '2001:db8::1' },
    ]) as {
      metadata: { name: string; ownerReferences: { uid: string; name: string }[] };
      spec: { egress: unknown[]; podSelector: unknown; policyTypes: string[] };
    };
    expect(policy.metadata.name).toBe('workspace-a-egress');
    expect(policy.metadata.ownerReferences).toEqual([
      { apiVersion: 'v1', kind: 'Pod', name: 'workspace-a', uid: UID },
    ]);
    expect(policy.spec.podSelector).toEqual({
      matchLabels: { 'asw/egress': 'blocked', 'asw/workspace': 'workspace-a' },
    });
    expect(policy.spec.policyTypes).toEqual(['Egress']);
    expect(policy.spec.egress).toEqual([
      { ports: [{ port: 443, protocol: 'TCP' }], to: [{ ipBlock: { cidr: '1.2.3.4/32' } }] },
      { to: [{ ipBlock: { cidr: '2001:db8::1/128' } }] },
    ]);
  });
});

describe('buildEgressAllowPolicy mode', () => {
  it('selects the restricted label when asked, and tolerates a ClusterIP entry as a plain ipBlock', () => {
    const policy = buildEgressAllowPolicy(
      'workspace-a',
      UID,
      'ns',
      [{ ip: '10.96.0.10', port: 8792 }],
      'restricted'
    ) as { spec: { podSelector: unknown; egress: unknown[] } };
    expect(policy.spec.podSelector).toEqual({
      matchLabels: { 'asw/egress': 'restricted', 'asw/workspace': 'workspace-a' },
    });
    expect(policy.spec.egress).toHaveLength(1);
  });
});

describe('lockPodEgress', () => {
  it('proves reachability, creates the pod-owned policy, labels, then verifies the same target', async () => {
    const { d, kubectl, probe } = deps();
    await lockPodEgress('workspace-a', [{ host: 'github.com', port: 443 }], d);
    const verbs = kubectl.mock.calls.map((c) => c[0][0]);
    expect(verbs).toEqual(['get', 'create', 'label']);
    expect(kubectl.mock.calls[1]?.[1]).toContain('140.82.112.3/32');
    expect(kubectl.mock.calls[2]?.[0]).toEqual(labelBlockedArgs('ns', 'workspace-a'));
    const scripts = probe.mock.calls.map((c) => c[0]);
    expect(scripts[0]).toContain('H=1.1.1.1; P=80');
    expect(scripts[1]).toBe(scripts[0]);
  });

  it('makes no policy and reads no uid when nothing is allowed', async () => {
    const { d, kubectl } = deps();
    await lockPodEgress('workspace-a', [], d);
    expect(kubectl.mock.calls.map((c) => c[0][0])).toEqual(['label']);
  });

  it('uses the next public target when the first is unreachable before the lock', async () => {
    const { d, kubectl, probe } = deps();
    probe.mockImplementation(async (script: string) => {
      if (script.includes('H=1.1.1.1; P=80')) {
        return BLOCKED;
      }
      return kubectl.mock.calls.some((c) => c[0][0] === 'label') ? BLOCKED : REACHED;
    });
    await lockPodEgress('workspace-a', [], d);
    const scripts = probe.mock.calls.map((c) => c[0]);
    expect(scripts[0]).toContain('H=1.1.1.1; P=80');
    expect(scripts[1]).toContain('H=1.1.1.1; P=443');
    expect(scripts[2]).toBe(scripts[1]);
  });

  it('fails closed, before labelling, when nothing public is reachable pre-lock', async () => {
    const { d, kubectl } = deps({ probe: async () => BLOCKED });
    await expect(lockPodEgress('workspace-a', [], d)).rejects.toThrow(
      /cannot verify the egress lock — no public probe address was reachable/
    );
    expect(kubectl).not.toHaveBeenCalled();
  });

  it('keeps polling until the CNI applies the change', async () => {
    const { d, probe, kubectl } = deps();
    let post = 0;
    probe.mockImplementation(async () => {
      if (!kubectl.mock.calls.some((c) => c[0][0] === 'label')) {
        return REACHED;
      }
      return post++ < 2 ? REACHED : BLOCKED;
    });
    d.verifyAttempts = 6;
    await lockPodEgress('workspace-a', [], d);
    // 1 pre-lock + R, R, B, B after the label.
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it('needs two consecutive closed samples: a single blip does not pass the lock', async () => {
    const { d, probe, kubectl } = deps();
    d.verifyAttempts = 4;
    const post = ['closed', 'open', 'closed', 'closed'];
    probe.mockImplementation(async () => {
      if (!kubectl.mock.calls.some((c) => c[0][0] === 'label')) {
        return REACHED;
      }
      return ok(`asw_probe=${post.shift()}\n`);
    });
    await lockPodEgress('workspace-a', [], d);
    expect(post).toEqual([]);

    const blip = deps();
    blip.d.verifyAttempts = 2;
    const seq = ['closed', 'open'];
    blip.probe.mockImplementation(async () =>
      blip.kubectl.mock.calls.some((c) => c[0][0] === 'label')
        ? ok(`asw_probe=${seq.shift()}\n`)
        : REACHED
    );
    await expect(lockPodEgress('workspace-a', [], blip.d)).rejects.toThrow(/egress is not blocked/);
  });

  it('skips a public probe target that is also an allowed address', async () => {
    const { d, probe } = deps({ lookup: async () => ['1.1.1.1'] });
    await lockPodEgress('workspace-a', [{ host: 'one.example', port: 80 }], d);
    const scripts = probe.mock.calls.map((c) => c[0]);
    // The pre-lock pick and the post-lock verification both use the first non-allowed target.
    expect(scripts[0]).toContain('H=8.8.8.8; P=443');
    expect(scripts[1]).toBe(scripts[0]);
    expect(scripts.slice(0, 2).some((sc) => sc.includes('H=1.1.1.1;'))).toBe(false);
  });

  it('labels and selects the pod as restricted in restricted mode', async () => {
    const { d, kubectl } = deps();
    await lockPodEgress('workspace-a', [{ host: 'github.com', port: 443 }], d, 'restricted');
    const label = kubectl.mock.calls.find((c) => c[0][0] === 'label');
    expect(label?.[0]).toEqual(labelBlockedArgs('ns', 'workspace-a', 'restricted'));
    expect(label?.[0]).toContain('asw/egress=restricted');
    expect(label?.[0]).not.toContain('asw/egress=blocked');
    const create = kubectl.mock.calls.find((c) => c[0][0] === 'create');
    expect(JSON.parse(create?.[1] ?? '{}').spec.podSelector).toEqual({
      matchLabels: { 'asw/egress': 'restricted', 'asw/workspace': 'workspace-a' },
    });
  });

  it('throws when the pod can still reach the public address after the label', async () => {
    const { d } = deps({ probe: async () => REACHED });
    await expect(lockPodEgress('workspace-a', [], d)).rejects.toThrow(/egress is not blocked/);
  });

  it('throws when the image has no probe tool, before or after the label', async () => {
    const pre = deps({ probe: async () => NOTOOL });
    await expect(lockPodEgress('workspace-a', [], pre.d)).rejects.toThrow(/no working TCP probe/);
    expect(pre.kubectl).not.toHaveBeenCalled();
    const { d, kubectl } = deps();
    d.probe = async () => (kubectl.mock.calls.length > 0 ? NOTOOL : REACHED);
    await expect(lockPodEgress('workspace-a', [], d)).rejects.toThrow(/egress is not blocked/);
  });

  it('does not read a failed exec (no verdict) as proof of a lock', async () => {
    const { d, kubectl } = deps();
    d.probe = async () =>
      kubectl.mock.calls.length > 0
        ? { exitCode: 1, stderr: 'unable to upgrade connection', stdout: '' }
        : REACHED;
    await expect(lockPodEgress('workspace-a', [], d)).rejects.toThrow(/egress is not blocked/);
  });

  it('throws when the label, the policy or the uid cannot be applied', async () => {
    const fail = { exitCode: 1, stderr: 'forbidden', stdout: '' };
    await expect(
      lockPodEgress('workspace-a', [], deps({ kubectl: async () => fail }).d)
    ).rejects.toThrow(/could not label/);
    await expect(
      lockPodEgress(
        'workspace-a',
        [{ host: 'github.com' }],
        deps({ kubectl: async (a) => (a[0] === 'get' ? ok(UID) : fail) }).d
      )
    ).rejects.toThrow(/could not create its egress policy/);
    await expect(
      lockPodEgress(
        'workspace-a',
        [{ host: 'github.com' }],
        deps({ kubectl: async () => ok('') }).d
      )
    ).rejects.toThrow(/uid/);
  });

  it('fails before touching the cluster when an allowed name does not resolve', async () => {
    const { d, kubectl } = deps({
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await expect(lockPodEgress('workspace-a', [{ host: 'nope.example' }], d)).rejects.toThrow();
    expect(kubectl).not.toHaveBeenCalled();
  });
});

describe('probeScript curl branch', () => {
  it('tests the direct path and maps curl exit codes to verdicts', () => {
    const script = probeScript({ host: '1.1.1.1', port: 80 });
    expect(script).toContain("--noproxy '*'");
    expect(script).toContain('env -u http_proxy -u https_proxy');
    expect(script).toContain('case "$r" in 7|28) return 1;;');
  });

  const runWithFakeCurl = (exitCode: number, message: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'probe-'));
    writeFileSync(
      path.join(dir, 'curl'),
      `#!/bin/sh\necho "$@" > "${dir}/args"\necho '${message}' >&2\nexit ${exitCode}\n`,
      { mode: 0o755 }
    );
    // PATH holds only the fake curl and `env`: nc, bash and timeout are absent, so the script
    // reaches try_curl.
    symlinkSync('/usr/bin/env', path.join(dir, 'env'));
    const out = execFileSync('/bin/sh', ['-c', probeScript({ host: '1.1.1.1', port: 80 })], {
      encoding: 'utf8',
      env: { PATH: dir },
      timeout: 15_000,
    });
    return { args: readFileSync(path.join(dir, 'args'), 'utf8'), out };
  };

  it.skipIf(!existsSync('/usr/bin/env'))(
    'reads curl 7, 28 as closed and tool errors as no verdict',
    () => {
      const closed7 = runWithFakeCurl(7, 'curl: (7) Failed to connect');
      expect(closed7.out).toContain('asw_probe=closed');
      expect(closed7.args).toContain('--noproxy *');
      expect(runWithFakeCurl(28, 'curl: (28) Timeout was reached').out).toContain(
        'asw_probe=closed'
      );
      for (const code of [2, 3, 6, 127]) {
        expect(runWithFakeCurl(code, 'curl: tool error').out, String(code)).toContain(
          'asw_probe=notool'
        );
      }
      expect(runWithFakeCurl(0, '').out).toContain('asw_probe=open');
    }
  );
});

describe('probeScript (run for real against localhost)', () => {
  const run = (port: number) =>
    execFileSync('sh', ['-c', probeScript({ host: '127.0.0.1', port })], {
      encoding: 'utf8',
      timeout: 15_000,
    });

  it('says open for a listening port and closed for a refused one', async () => {
    const server = net.createServer((c) => c.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const open = run(port);
      expect(open).toMatch(/asw_probe=open/);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(run(port)).toMatch(/asw_probe=(closed|notool)/);
  });
});
