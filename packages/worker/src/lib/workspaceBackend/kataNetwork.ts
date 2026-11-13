import { isIP } from 'node:net';
import { execShellAsync } from '../execUtils.js';
import { shellQuote } from '../shellQuote.js';
import { METADATA_V4 } from './kubernetes/egressLock.js';
import { workspaceLabelArgs } from './orphans.js';

type Fields = Record<string, unknown>;
export interface KataAllow {
  ip: string;
  port?: number;
  protocol?: 'tcp' | 'udp';
}
export interface KataBaseline {
  allow: KataAllow[];
  cidrs: string[];
  privateRanges: string[];
  blockPrivate: boolean;
  blockMetadata: boolean;
}
export interface KataTopology {
  tap: string;
  lower: string;
}
interface Rule {
  device: string;
  chain: number;
  pref: number;
  protocol: string;
  kind: string;
  keys: Fields;
  actions: Fields[];
  command: string;
}
export interface KataPolicy {
  topology: KataTopology;
  rules: Rule[];
  script: string;
}

function record(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Kata network: invalid helper report');
  }
  return value as Fields;
}

function array(value: unknown): Fields[] {
  if (!Array.isArray(value)) {
    throw new Error('Kata network: invalid helper array');
  }
  return value.map(record);
}

function redirect(target: string): Fields {
  return {
    control_action: { type: 'stolen' },
    direction: 'egress',
    kind: 'mirred',
    mirred_action: 'redirect',
    to_dev: target,
  };
}

function matches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const a = record(actual);
    return Object.entries(expected).every(([key, value]) => matches(a[key], value));
  }
  return actual === expected;
}

export function detectKataTopology(report: string): KataTopology {
  const data = record(JSON.parse(report));
  const links = array(data.links).filter((link) => link.ifname !== 'lo');
  const tap = links.find((link) => record(link.linkinfo).info_kind === 'tun');
  const lower = links.find((link) => record(link.linkinfo).info_kind === 'veth');
  if (
    links.length !== 2 ||
    !tap ||
    !lower ||
    record(record(tap.linkinfo).info_data).type !== 'tap' ||
    tap.ifname !== 'tap0_kata' ||
    lower.ifname !== 'eth0'
  ) {
    throw new Error('Kata network: only the tcfilter tun/tap + veth topology is supported');
  }
  for (const [filters, target] of [
    [data.tap, 'eth0'],
    [data.lower, 'tap0_kata'],
  ] as const) {
    const redirects = array(filters).filter((filter) => {
      if (filter.pref !== 49152 || filter.kind !== 'u32' || filter.chain !== 0) {
        return false;
      }
      const options = filter.options ? record(filter.options) : {};
      const actions = options.actions ? array(options.actions) : [];
      return actions.length === 1 && matches(actions[0], redirect(target));
    });
    if (redirects.length !== 1) {
      throw new Error('Kata network: missing or ambiguous Kata redirect');
    }
  }
  return { lower: 'eth0', tap: 'tap0_kata' };
}

export const KATA_TOOLS = [
  'set -eu',
  'command -v ip >/dev/null && command -v tc >/dev/null && command -v nft >/dev/null',
].join('\n');

export const KATA_GUARD = [
  KATA_TOOLS,
  'nft add table netdev asw_kata_guard',
  `nft 'add chain netdev asw_kata_guard incoming { type filter hook ingress device "eth0" priority -500; policy drop; }'`,
  `nft 'add chain netdev asw_kata_guard outgoing { type filter hook egress device "eth0" priority -500; policy drop; }'`,
  'nft -j list table netdev asw_kata_guard',
  `printf '\\nKATA-GUARD-DEVICES\\n'`,
  'nft list table netdev asw_kata_guard',
].join('\n');

export function assertKataGuard(report: string): void {
  const [json = '', text = ''] = report.split('\nKATA-GUARD-DEVICES\n');
  const data = record(JSON.parse(json));
  const chains = array(data.nftables).flatMap((entry) =>
    entry.chain ? [record(entry.chain)] : []
  );
  if (
    chains.length !== 2 ||
    array(data.nftables).some((entry) => entry.rule) ||
    !['ingress', 'egress'].every((hook) =>
      chains.some(
        (chain) =>
          chain.family === 'netdev' &&
          chain.table === 'asw_kata_guard' &&
          chain.type === 'filter' &&
          chain.hook === hook &&
          chain.policy === 'drop' &&
          chain.prio === -500
      )
    ) ||
    !['incoming ingress', 'outgoing egress'].every((pair) => {
      const [name, hook] = pair.split(' ');
      return new RegExp(
        `chain ${name} \\{\\s*type filter hook ${hook} device "?eth0"? priority -500; policy drop;\\s*\\}`
      ).test(text);
    })
  ) {
    throw new Error('Kata network: initial guard verification failed');
  }
}

export function kataReport(topology = false): string {
  return [
    `printf '{${topology ? '"links":' : ''}'`,
    ...(topology ? ['ip -j -d link', `printf ',"tap":'`] : [`printf '"tap":'`]),
    'tc -j filter show dev tap0_kata ingress',
    `printf ',"lower":'`,
    'tc -j filter show dev eth0 ingress',
    `printf '}'`,
  ].join('\n');
}

function address(ip: string): string | undefined {
  const [host = '', prefix] = ip.split('/');
  const family = isIP(host);
  if (
    !family ||
    ip.split('/').length > 2 ||
    (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
  ) {
    throw new Error('Kata network: invalid IP rule');
  }
  return family === 4 ? (prefix === '32' ? host : ip) : undefined;
}

export function buildKataPolicy(
  topology: KataTopology,
  zone: number,
  baseline: KataBaseline | undefined,
  allow: KataAllow[] = [],
  incoming: KataAllow[] = []
): KataPolicy {
  if (topology.tap !== 'tap0_kata' || topology.lower !== 'eth0') {
    throw new Error('Kata network: unverified topology');
  }
  if (!Number.isInteger(zone) || zone < 1 || zone > 65535) {
    throw new Error('Kata network: exhausted conntrack generations');
  }
  const { tap, lower } = topology;
  const rules: Rule[] = [];
  const drop = { control_action: { type: 'drop' }, kind: 'gact' };
  const forward = (target: string, mark?: number): Fields[] => [
    ...(mark === undefined
      ? []
      : [{ action: 'commit', control_action: { type: 'pipe' }, kind: 'ct', mark, zone }]),
    redirect(target),
  ];
  const add = (
    device: string,
    chain: number,
    pref: number,
    protocol: string,
    keys: Fields,
    actions: Fields[],
    match = '',
    action = 'drop',
    kind = 'flower'
  ) => {
    rules.push({
      actions,
      chain,
      command: `tc filter add dev ${device} ingress chain ${chain} pref ${pref} handle 1 protocol ${protocol} ${kind}${kind === 'flower' ? ' skip_hw' : ''} ${match} action ${action}`,
      device,
      keys: {
        ...(protocol === 'all' ? {} : { eth_type: protocol === 'ip' ? 'ipv4' : protocol }),
        ...keys,
      },
      kind,
      pref,
      protocol,
    });
  };
  const send = (target: string, mark?: number) =>
    `${mark === undefined ? '' : `ct commit zone ${zone} mark ${mark} pipe action `}mirred egress redirect dev ${target}`;
  const ipRule = (
    device: string,
    pref: number,
    keys: Fields,
    actions: Fields[],
    match: string,
    action: string
  ) => add(device, 10, pref, 'ip', keys, actions, match, action);
  for (const [device, target] of [
    [tap, lower],
    [lower, tap],
  ]) {
    if (!device || !target) {
      throw new Error('Kata network: missing interface');
    }
    add(device, 0, 2, 'ipv6', {}, [drop]);
    add(
      device,
      0,
      10,
      'ip',
      {},
      [
        { control_action: { type: 'pipe' }, kind: 'ct', zone },
        { control_action: { chain: 10, type: 'goto' }, kind: 'gact' },
      ],
      '',
      `ct zone ${zone} pipe action goto chain 10`
    );
    add(device, 0, 1000, 'arp', {}, forward(target), '', send(target));
    add(device, 0, 2000, 'all', {}, [drop], '', 'drop', 'matchall');
  }
  if (!baseline || baseline.blockMetadata) {
    ['169.254.169.254', '169.254.170.2', ...METADATA_V4].forEach((ip, i) => {
      ipRule(tap, 10 + i, { dst_ip: ip }, [drop], `dst_ip ${ip}`, 'drop');
    });
  }
  if (baseline) {
    for (const [i, [state, mark]] of (
      [
        ['est', 1],
        ['est', 2],
        ['rel', 1],
        ['rel', 2],
      ] as const
    ).entries()) {
      ipRule(
        tap,
        20 + i,
        { ct_mark: mark, ct_mark_mask: '3', ct_state: `+trk+${state}` },
        forward(lower),
        `ct_state +trk+${state} ct_mark ${mark}/3`,
        send(lower)
      );
    }
  }
  for (const [i, [state, mark]] of (
    [
      ['est', 1],
      ['est', 2],
      ['rel', 1],
      ['rel', 2],
    ] as const
  ).entries()) {
    ipRule(
      lower,
      20 + i,
      { ct_mark: mark, ct_mark_mask: '3', ct_state: `+trk+${state}` },
      forward(tap),
      `ct_state +trk+${state} ct_mark ${mark}/3`,
      send(tap)
    );
  }
  const permitted = baseline ? (baseline.blockPrivate ? baseline.allow : []) : allow;
  if (permitted.length > 10000 || incoming.length > 10000) {
    throw new Error('Kata network: too many rules');
  }
  for (const [i, entry] of permitted.entries()) {
    const ip = address(entry.ip);
    if (
      entry.port !== undefined &&
      (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535)
    ) {
      throw new Error('Kata network: invalid port');
    }
    if (entry.protocol !== undefined && entry.protocol !== 'tcp' && entry.protocol !== 'udp') {
      throw new Error('Kata network: invalid protocol');
    }
    if (!ip) {
      continue;
    }
    const proto = entry.protocol ?? 'tcp';
    ipRule(
      tap,
      100 + i,
      {
        dst_ip: ip,
        ...(entry.port === undefined ? {} : { dst_port: entry.port, ip_proto: proto }),
      },
      forward(lower, 2),
      `dst_ip ${ip}${entry.port === undefined ? '' : ` ip_proto ${proto} dst_port ${entry.port}`}`,
      send(lower, 2)
    );
  }
  for (const [i, entry] of incoming.entries()) {
    const ip = address(entry.ip);
    if (!entry.port || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
      throw new Error('Kata network: incoming TCP port required');
    }
    if (!ip) {
      continue;
    }
    ipRule(
      lower,
      100 + i,
      { ct_state: '+trk+new', dst_port: entry.port, ip_proto: 'tcp', src_ip: ip },
      forward(tap, 1),
      `src_ip ${ip} ip_proto tcp dst_port ${entry.port} ct_state +trk+new`,
      send(tap, 1)
    );
    if (!baseline) {
      ipRule(
        tap,
        11000 + i,
        {
          ct_mark: 1,
          ct_mark_mask: '3',
          ct_state: '+trk+est',
          dst_ip: ip,
          ip_proto: 'tcp',
          src_port: entry.port,
        },
        forward(lower),
        `dst_ip ${ip} ip_proto tcp src_port ${entry.port} ct_state +trk+est ct_mark 1/3`,
        send(lower)
      );
    }
  }
  if (baseline?.blockPrivate) {
    baseline.cidrs.forEach((cidr, i) => {
      const ip = address(cidr);
      if (ip) {
        ipRule(tap, 21000 + i, { dst_ip: ip }, forward(lower, 2), `dst_ip ${ip}`, send(lower, 2));
      }
    });
    baseline.privateRanges.forEach((cidr, i) => {
      const ip = address(cidr);
      if (ip) {
        ipRule(tap, 22000 + i, { dst_ip: ip }, [drop], `dst_ip ${ip}`, 'drop');
      }
    });
  }
  ipRule(
    tap,
    30000,
    {},
    baseline ? forward(lower, 2) : [drop],
    '',
    baseline ? send(lower, 2) : 'drop'
  );
  ipRule(
    lower,
    30000,
    {},
    baseline ? forward(tap, 1) : [drop],
    '',
    baseline ? send(tap, 1) : 'drop'
  );
  const script = ['set -eu'];
  for (const device of [tap, lower]) {
    script.push(
      `tc filter add dev ${device} ingress pref 1 handle 1 protocol all matchall action drop`
    );
  }
  for (const device of [tap, lower]) {
    for (const pref of [2, 10, 1000, 2000]) {
      script.push(`tc filter del dev ${device} ingress pref ${pref} 2>/dev/null || true`);
    }
    script.push(`tc chain del dev ${device} ingress chain 10 2>/dev/null || true`);
  }
  script.push(...rules.map((rule) => rule.command), kataReport());
  return { rules, script: script.join('\n'), topology };
}

export function verifyKataPolicy(policy: KataPolicy, report: string, guarded = true): void {
  const data = record(JSON.parse(report));
  for (const [key, device] of [
    ['tap', policy.topology.tap],
    ['lower', policy.topology.lower],
  ]) {
    const actual = array(data[key as string])
      .filter((rule) => rule.options && record(rule.options).actions !== undefined)
      .filter((rule) => !(rule.pref === 49152 && rule.kind === 'u32' && (rule.chain ?? 0) === 0));
    const expected = policy.rules.filter((rule) => rule.device === device);
    const guardedRules = actual.filter((rule) => rule.pref === 1 && (rule.chain ?? 0) === 0);
    const guardActions = guardedRules.length ? array(record(guardedRules[0]?.options).actions) : [];
    if (
      guardedRules.length !== (guarded ? 1 : 0) ||
      (guarded &&
        (guardedRules[0]?.kind !== 'matchall' ||
          guardedRules[0]?.protocol !== 'all' ||
          guardActions.length !== 1 ||
          !matches(guardActions[0], {
            control_action: { type: 'drop' },
            kind: 'gact',
          })))
    ) {
      throw new Error('Kata network: missing or stale transition guard');
    }
    const filters = actual.filter((rule) => rule.pref !== 1);
    if (filters.length !== expected.length) {
      throw new Error('Kata network: unexpected filter count');
    }
    for (const rule of expected) {
      const found = filters.filter(
        (entry) => entry.pref === rule.pref && (entry.chain ?? 0) === rule.chain
      );
      if (found.length !== 1) {
        throw new Error('Kata network: missing or duplicate rule');
      }
      const entry = found[0];
      const options = record(entry?.options);
      const actions = array(options.actions);
      const keys = options.keys ? record(options.keys) : {};
      if (
        entry?.kind !== rule.kind ||
        entry.protocol !== rule.protocol ||
        Object.keys(keys).length !== Object.keys(rule.keys).length ||
        !matches(keys, rule.keys) ||
        actions.length !== rule.actions.length ||
        !rule.actions.every((action, i) => matches(actions[i], action))
      ) {
        throw new Error('Kata network: filter verification failed');
      }
    }
  }
}

export function releaseKataPolicy(policy: KataPolicy): string {
  return [
    'set -eu',
    ...[policy.topology.tap, policy.topology.lower].map(
      (device) => `tc filter del dev ${device} ingress pref 1`
    ),
    kataReport(),
  ].join('\n');
}

export function kataChildArgs(sandbox: string): string[] {
  if (!/^[a-f0-9]{64}$/.test(sandbox)) {
    throw new Error('Kata network: invalid sandbox ID');
  }
  return [
    '--annotation=io.kubernetes.cri.container-type=container',
    `--annotation=io.kubernetes.cri.sandbox-id=${sandbox}`,
  ];
}

export function kataHelperCommand(holder: string, image: string, script: string): string {
  return [
    'docker',
    'run',
    '--rm',
    ...workspaceLabelArgs(),
    '--runtime=runc',
    `--network=container:${holder}`,
    '--cap-drop=ALL',
    '--cap-add=NET_ADMIN',
    '--security-opt=no-new-privileges',
    '--read-only',
    '--tmpfs=/run:size=1m,mode=755',
    '--memory=128m',
    '--pids-limit=64',
    '--entrypoint=/bin/sh',
    '--',
    image,
    '-ec',
    script,
  ]
    .map(shellQuote)
    .join(' ');
}

export class KataNetworkGroup {
  readonly holder: string;
  readonly sandbox: string;
  sandboxId = '';
  private zone = 31000;
  private changing = false;
  private ready = false;
  private destroyed = false;

  constructor(
    readonly owner: string,
    readonly image: string
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(owner)) {
      throw new Error('Kata network: invalid owner');
    }
    this.holder = `${owner}-net`;
    this.sandbox = `${owner}-sandbox`;
  }

  private run(args: string[]): Promise<string> {
    return execShellAsync(['docker', ...args].map(shellQuote).join(' '), {
      heartbeatLabel: 'workspace: preparing Kata network',
      timeoutMs: 120_000,
    });
  }

  helper(script: string): Promise<string> {
    return execShellAsync(kataHelperCommand(this.holder, this.image, script), {
      heartbeatLabel: 'workspace: enforcing Kata network',
      timeoutMs: 60_000,
    });
  }

  async start(
    holderArgs: string[],
    runtime: string,
    resources: { memory: string; cpus: number },
    baseline: () => Promise<KataBaseline>
  ): Promise<void> {
    if (this.destroyed || this.sandboxId) {
      throw new Error('Kata network: group cannot be restarted');
    }
    try {
      await this.run(holderArgs);
      const config = await baseline();
      assertKataGuard(await this.helper(KATA_GUARD));
      this.sandboxId = (
        await this.run([
          'run',
          '-d',
          '--name',
          this.sandbox,
          `--runtime=${runtime}`,
          ...workspaceLabelArgs(),
          '--label',
          `asw.workspace=${this.owner}`,
          `--network=container:${this.holder}`,
          '--annotation=io.kubernetes.cri.container-type=sandbox',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          `--memory=${resources.memory}`,
          `--cpus=${resources.cpus}`,
          '--pids-limit=64',
          '--entrypoint=sleep',
          '--',
          this.image,
          'infinity',
        ])
      ).trim();
      kataChildArgs(this.sandboxId);
      await this.install(config);
      await this.helper('set -eu\nnft delete table netdev asw_kata_guard');
      this.ready = true;
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }

  childArgs(): string[] {
    if (!this.ready || this.changing || this.destroyed) {
      throw new Error('Kata network: enforcement is not ready');
    }
    return [
      ...kataChildArgs(this.sandboxId),
      '--label',
      `asw.kata.holder=${this.holder}`,
      '--label',
      `asw.workspace=${this.owner}`,
    ];
  }

  async install(
    baseline?: KataBaseline,
    allow: KataAllow[] = [],
    incoming: KataAllow[] = []
  ): Promise<void> {
    if (this.destroyed) {
      throw new Error('Kata network: group has been destroyed');
    }
    if (this.changing) {
      await this.destroy();
      throw new Error('Kata network: concurrent policy replacement refused');
    }
    this.changing = true;
    try {
      const topology = detectKataTopology(await this.helper(kataReport(true)));
      const policy = buildKataPolicy(topology, ++this.zone, baseline, allow, incoming);
      verifyKataPolicy(policy, await this.helper(policy.script));
      verifyKataPolicy(policy, await this.helper(releaseKataPolicy(policy)), false);
      if (this.destroyed) {
        throw new Error('Kata network: group was destroyed during replacement');
      }
    } catch (error) {
      await this.destroy();
      throw error;
    } finally {
      this.changing = false;
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.ready = false;
    // Stop the VM before releasing the namespace and its filters.
    for (const name of [this.sandbox, this.holder]) {
      await this.run(['rm', '-f', '--', name]).catch(() => undefined);
    }
  }
}
