import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execShellAsync } from '../execUtils.js';
import {
  assertKataGuard,
  buildKataPolicy,
  detectKataTopology,
  KataNetworkGroup,
  kataChildArgs,
  kataHelperCommand,
  releaseKataPolicy,
  verifyKataPolicy,
} from './kataNetwork.js';

vi.mock('../execUtils.js', () => ({ execShellAsync: vi.fn() }));
const topology = { lower: 'eth0', tap: 'tap0_kata' };
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('missing fixture value');
  }
  return value;
}
const redirect = (to_dev: string) => ({
  control_action: { type: 'stolen' },
  direction: 'egress',
  kind: 'mirred',
  mirred_action: 'redirect',
  to_dev,
});
const layout = () => ({
  links: [
    { ifname: 'lo' },
    { ifname: 'eth0', linkinfo: { info_kind: 'veth' } },
    { ifname: 'tap0_kata', linkinfo: { info_data: { type: 'tap' }, info_kind: 'tun' } },
  ],
  lower: [{ chain: 0, kind: 'u32', options: { actions: [redirect('tap0_kata')] }, pref: 49152 }],
  tap: [{ chain: 0, kind: 'u32', options: { actions: [redirect('eth0')] }, pref: 49152 }],
});
const baseline = {
  allow: [{ ip: '10.1.2.3', port: 53, protocol: 'udp' as const }],
  blockMetadata: true,
  blockPrivate: true,
  cidrs: ['10.2.0.0/16'],
  privateRanges: ['10.0.0.0/8'],
};
const guards = () => {
  const nftables = ['ingress', 'egress'].map((hook) => ({
    chain: {
      family: 'netdev',
      hook,
      policy: 'drop',
      prio: -500,
      table: 'asw_kata_guard',
      type: 'filter',
    },
  }));
  return `${JSON.stringify({ nftables })}\nKATA-GUARD-DEVICES\nchain incoming { type filter hook ingress device "eth0" priority -500; policy drop; }\nchain outgoing { type filter hook egress device "eth0" priority -500; policy drop; }`;
};
function report(policy: ReturnType<typeof buildKataPolicy>, guarded = true) {
  return Object.fromEntries(
    ['tap', 'lower'].map((key) => [
      key,
      [
        ...(guarded
          ? [
              {
                chain: 0,
                kind: 'matchall',
                options: { actions: [{ control_action: { type: 'drop' }, kind: 'gact' }] },
                pref: 1,
                protocol: 'all',
              },
            ]
          : []),
        ...policy.rules
          .filter((rule) => rule.device === policy.topology[key as keyof typeof topology])
          .map((rule) => ({
            chain: rule.chain,
            kind: rule.kind,
            options: { actions: rule.actions, keys: rule.keys },
            pref: rule.pref,
            protocol: rule.protocol,
          })),
      ],
    ])
  );
}

describe('Kata topology', () => {
  it('requires device types and reciprocal Kata redirects', () => {
    expect(detectKataTopology(JSON.stringify(layout()))).toEqual(topology);
  });
  it.each(['macvtap', 'veth', 'dummy'])('refuses a tap-shaped %s', (kind) => {
    const input = layout();
    required(required(input.links[2]).linkinfo).info_kind = kind;
    expect(() => detectKataTopology(JSON.stringify(input))).toThrow();
  });
  it('refuses missing, extra and reversed redirects', () => {
    for (const mutate of [
      (input: ReturnType<typeof layout>) => {
        input.tap = [];
      },
      (input: ReturnType<typeof layout>) => {
        input.tap.push(required(input.tap[0]));
      },
      (input: ReturnType<typeof layout>) => {
        required(required(input.lower[0]).options.actions[0]).to_dev = 'eth0';
      },
    ]) {
      const input = layout();
      mutate(input);
      expect(() => detectKataTopology(JSON.stringify(input))).toThrow();
    }
  });
  it.each(['{}', '[]', '', '{'])('rejects empty/malformed helper report %j', (input) => {
    expect(() => detectKataTopology(input)).toThrow();
  });
  it('requires verified drop guards on both named interfaces with no accept rules', () => {
    expect(() => assertKataGuard(guards())).not.toThrow();
    for (const input of [
      guards().replaceAll('drop', 'accept'),
      guards().replaceAll('eth0', 'eth1'),
      guards().split('\nKATA-GUARD-DEVICES')[0] ?? '',
    ]) {
      expect(() => assertKataGuard(input)).toThrow();
    }
  });
});

describe('Kata policy', () => {
  it('blocks IPv6 and unknown L2 while preserving ARP and using actual conntrack', () => {
    const policy = buildKataPolicy(topology, 31001, baseline);
    expect(policy.script).toContain('protocol ipv6 flower skip_hw');
    expect(policy.script).toContain('protocol arp flower skip_hw');
    expect(policy.script).toContain('protocol all matchall  action drop');
    expect(policy.script).toContain('ct zone 31001 pipe action goto chain 10');
    expect(policy.script).not.toContain('tcp_flags');
    expect(policy.script).not.toContain('filter del dev tap0_kata ingress pref 1\n');
  });
  it('places metadata before private exceptions and private blocks', () => {
    const script = buildKataPolicy(topology, 31001, baseline).script;
    expect(script.indexOf('dst_ip 169.254.169.254')).toBeLessThan(
      script.indexOf('dst_ip 10.1.2.3')
    );
    expect(script.indexOf('dst_ip 10.1.2.3')).toBeLessThan(script.indexOf('dst_ip 10.0.0.0/8'));
    expect(script).toContain('dst_ip 10.1.2.3 ip_proto udp dst_port 53');
  });
  it('does not grandfather outbound established/RELATED traffic under a strict lock', () => {
    const policy = buildKataPolicy(
      topology,
      31002,
      undefined,
      [{ ip: '1.1.1.1', port: 443 }],
      [{ ip: '10.0.0.1', port: 8080 }]
    );
    const outbound = policy.rules.filter(
      (rule) => rule.device === topology.tap && rule.chain === 10
    );
    expect(outbound.some((rule) => rule.keys.ct_state === '+trk+rel')).toBe(false);
    const reply = outbound.find((rule) => rule.keys.ct_state === '+trk+est');
    expect(reply?.keys).toMatchObject({
      ct_mark: 1,
      dst_ip: '10.0.0.1',
      ip_proto: 'tcp',
      src_port: 8080,
    });
    expect(policy.script).toContain('dst_port 8080 ct_state +trk+new');
    expect(policy.script).toContain('dst_ip 1.1.1.1 ip_proto tcp dst_port 443');
  });
  it('has a terminal IPv4 drop for an empty strict list', () => {
    const policy = buildKataPolicy(topology, 31001, undefined);
    expect(
      policy.rules
        .filter((rule) => rule.pref === 30000)
        .every(
          (rule) =>
            rule.actions[0]?.control_action &&
            (rule.actions[0].control_action as { type: string }).type === 'drop'
        )
    ).toBe(true);
  });
  it('validates inputs before constructing helper commands', () => {
    for (const allow of [
      [{ ip: '1.1.1.1; evil' }],
      [{ ip: '10.0.0.1/999' }],
      [{ ip: '10.0.0.1', port: 0 }],
    ]) {
      expect(() => buildKataPolicy(topology, 31001, undefined, allow)).toThrow();
    }
    expect(() => buildKataPolicy(topology, 65536, baseline)).toThrow('generations');
    expect(() => kataChildArgs('unowned')).toThrow();
  });
  it('omits IPv6 allowances without making IPv6 reachable', () => {
    const policy = buildKataPolicy(topology, 31001, undefined, [{ ip: '2001:4860:4860::8888' }]);
    expect(policy.script).not.toContain('dst_ip 2001');
    expect(policy.rules.filter((rule) => rule.protocol === 'ipv6')).toHaveLength(2);
  });
  it('checks exact rules, state, zones and terminal actions before releasing guards', () => {
    const policy = buildKataPolicy(topology, 31001, baseline);
    const valid = report(policy);
    expect(() => verifyKataPolicy(policy, JSON.stringify(valid))).not.toThrow();
    for (const mutate of [
      (input: typeof valid) => {
        input.tap?.pop();
      },
      (input: typeof valid) => {
        input.lower?.push(required(input.lower?.[1]));
      },
      (input: typeof valid) => {
        input.tap?.shift();
      },
      (input: typeof valid) => {
        input.tap?.push({
          chain: 0,
          options: { actions: [{ control_action: { type: 'pass' }, kind: 'gact' }] },
          pref: 3,
        } as never);
      },
    ]) {
      const input = structuredClone(valid);
      mutate(input);
      expect(() => verifyKataPolicy(policy, JSON.stringify(input))).toThrow();
    }
    expect(releaseKataPolicy(policy)).toContain('filter del dev eth0 ingress pref 1');
    expect(() =>
      verifyKataPolicy(policy, JSON.stringify(report(policy, false)), false)
    ).not.toThrow();
  });
  it('runs only trusted runc NET_ADMIN helpers with bounded resources', () => {
    const command = kataHelperCommand('owner-net', 'helper:fixed', 'tc test');
    expect(command).toContain('--runtime=runc');
    expect(command).toContain('--cap-drop=ALL');
    expect(command).toContain('--cap-add=NET_ADMIN');
    expect(command).toContain('--memory=128m');
    expect(command).not.toContain('--privileged');
  });
});

describe('Kata guarded lifecycle', () => {
  beforeEach(() => vi.resetAllMocks());
  it('destroys the group when replacement overlaps, and rejects reuse', async () => {
    const group = new KataNetworkGroup('workspace-concurrent', 'helper:fixed');
    let release = (_report: string) => {};
    const delayed = new Promise<string>((resolve) => {
      release = resolve;
    });
    const policy = buildKataPolicy(topology, 31001, baseline);
    vi.mocked(execShellAsync).mockImplementation(async (command) => {
      if (command.includes('ip -j -d link')) {
        return delayed;
      }
      if (command.includes('ct zone')) {
        return JSON.stringify(report(policy));
      }
      if (command.includes('filter del dev tap0_kata ingress pref 1')) {
        return JSON.stringify(report(policy, false));
      }
      return '';
    });
    const first = group.install(baseline);
    const rejection = expect(first).rejects.toThrow('destroyed');
    await expect(group.install()).rejects.toThrow('concurrent');
    release(JSON.stringify(layout()));
    await rejection;
    expect(() => group.childArgs()).toThrow('not ready');
    await expect(group.install()).rejects.toThrow('destroyed');
  });
  it.each(['holder', 'baseline', 'guard', 'sandbox', 'topology', 'ct', 'verify'])(
    'tears down after %s failure before author creation',
    async (stage) => {
      const group = new KataNetworkGroup('workspace-test', 'helper:fixed');
      const run = vi.mocked(execShellAsync);
      run.mockImplementation(async (command) => {
        if (command.includes(' rm ') || command.includes("'rm'")) {
          return '';
        }
        if (stage === 'holder' && command.includes("'--name' 'holder'")) {
          throw new Error(stage);
        }
        if (command.includes('nft add table')) {
          if (stage === 'guard') {
            throw new Error(stage);
          }
          return guards();
        }
        if (command.includes('container-type=sandbox')) {
          if (stage === 'sandbox') {
            throw new Error(stage);
          }
          return 'a'.repeat(64);
        }
        if (command.includes('ip -j -d link')) {
          if (stage === 'topology') {
            throw new Error(stage);
          }
          return JSON.stringify(layout());
        }
        if (command.includes('ct zone')) {
          if (stage === 'ct') {
            throw new Error(stage);
          }
          return '{}';
        }
        return '';
      });
      await expect(
        group.start(
          ['run', '--name', 'holder'],
          'io.containerd.kata.v2',
          { cpus: 1, memory: '512m' },
          async () => {
            if (stage === 'baseline') {
              throw new Error(stage);
            }
            return baseline;
          }
        )
      ).rejects.toThrow();
      const commands = run.mock.calls.map(([command]) => command).join('\n');
      expect(commands).toContain('workspace-test-sandbox');
      expect(commands).toContain('workspace-test-net');
      expect(commands).not.toContain('container-type=container');
      if (['holder', 'baseline', 'guard'].includes(stage)) {
        expect(commands).not.toContain('container-type=sandbox');
      }
    }
  );
  it('keeps the holder guards until verification, shares the owned VM, and replaces with a fresh zone', async () => {
    const group = new KataNetworkGroup('workspace-test', 'helper:fixed');
    expect(() => group.childArgs()).toThrow('not ready');
    let current = buildKataPolicy(topology, 31001, baseline);
    const run = vi.mocked(execShellAsync);
    run.mockImplementation(async (command) => {
      if (command.includes('nft add table')) {
        return guards();
      }
      if (command.includes('container-type=sandbox')) {
        return 'a'.repeat(64);
      }
      if (command.includes('ip -j -d link')) {
        return JSON.stringify(layout());
      }
      if (command.includes('ct zone 31001')) {
        return JSON.stringify(report(current));
      }
      if (command.includes('ct zone 31002')) {
        current = buildKataPolicy(topology, 31002, undefined);
        return JSON.stringify(report(current));
      }
      if (command.includes('filter del dev tap0_kata ingress pref 1')) {
        return JSON.stringify(report(current, false));
      }
      return '';
    });
    await group.start(
      ['run', '--name', 'holder'],
      'io.containerd.kata.v2',
      { cpus: 1, memory: '512m' },
      async () => baseline
    );
    const commands = run.mock.calls.map(([command]) => command);
    expect(commands.findIndex((command) => command.includes('nft add table'))).toBeLessThan(
      commands.findIndex((command) => command.includes('container-type=sandbox'))
    );
    expect(
      commands.findIndex((command) => command.includes('filter del dev tap0_kata ingress pref 1'))
    ).toBeLessThan(commands.findIndex((command) => command.includes('nft delete table')));
    const sandbox = required(
      commands.find((command) => command.includes('container-type=sandbox'))
    );
    expect(sandbox).toContain('--cap-drop=ALL');
    expect(sandbox).toContain('--security-opt=no-new-privileges');
    expect(sandbox).toContain('auto-swe.workspace=true');
    expect(sandbox).toContain('asw.workspace=workspace-test');
    expect(sandbox).not.toContain('--mount');
    expect(group.childArgs()).toContain(
      `--annotation=io.kubernetes.cri.sandbox-id=${'a'.repeat(64)}`
    );
    await group.install();
    expect(current.script).toContain('ct zone 31002');
    await group.destroy();
    expect(() => group.childArgs()).toThrow('not ready');
    await expect(group.install()).rejects.toThrow('destroyed');
    const removals = run.mock.calls
      .map(([command]) => command)
      .filter((command) => command.includes("'rm'"));
    expect(removals.at(-2)).toContain('workspace-test-sandbox');
    expect(removals.at(-1)).toContain('workspace-test-net');
  });
});
