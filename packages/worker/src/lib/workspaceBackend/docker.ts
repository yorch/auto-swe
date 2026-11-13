import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DOCKER_HOST_ALIAS, resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { egressPolicyFailure } from '../egressWiring.js';
import {
  type CappedFileResult,
  type CapturedResult,
  execShellAsync,
  spawnCaptureAsync,
  spawnToFileCapped,
  spawnWithStdinAsync,
} from '../execUtils.js';
import { shellQuote } from '../shellQuote.js';
import { assertNoCredentialEnvPairs } from './credentialEnv.js';
import { type KataBaseline, KataNetworkGroup, kataHelperCommand } from './kataNetwork.js';
import {
  isForbiddenAllowAddress,
  METADATA_V4,
  type ResolvedAllow,
} from './kubernetes/egressLock.js';
import {
  dockerListArgs,
  MAX_REAPED_PER_SWEEP,
  parseDockerListing,
  selectExpiredContainers,
  type WorkspaceReapResult,
  workspaceLabelArgs,
} from './orphans.js';
import { assertSecretEnvName, secretEnvFlags } from './secretEnvName.js';
import type {
  EgressAllowEntry,
  EphemeralContainerSpec,
  EphemeralRunOptions,
  HelperContainerSpec,
  LockEgressOptions,
  WorkspaceBackend,
  WorkspaceContainerSpec,
  WorkspaceExecOptions,
  WorkspaceHandle,
  WorkspaceServiceSpec,
  WorkspaceSpawnOptions,
} from './types.js';

const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Shell prelude: make sure `iptables`/`ip6tables` exist, installing them only if absent. */
const IPTABLES_PRELUDE = [
  'set -eu',
  'if ! command -v iptables >/dev/null 2>&1 || ! command -v ip6tables >/dev/null 2>&1; then',
  '  apk add --no-cache iptables ip6tables >/dev/null || { echo "egress lock: helper image has no iptables" >&2; exit 1; }',
  'fi',
];

/**
 * Validate one allow entry before it reaches any command. Returns the host (an IP literal or a
 * DNS name) and the port, or throws. Entries are untrusted: a host may only be an IP literal or a
 * plain hostname, a port only an integer in 1..65535.
 */
function checkEgressEntry(entry: EgressAllowEntry): { host: string; port?: number; ip: boolean } {
  const host = entry.host;
  if (typeof host !== 'string') {
    throw new Error('egress allow entry: host must be a string');
  }
  const ip = isIP(host) !== 0;
  if (!ip && !HOSTNAME_RE.test(host)) {
    throw new Error(`egress allow entry: invalid host ${JSON.stringify(host)}`);
  }
  if (entry.port !== undefined) {
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
      throw new Error(`egress allow entry: invalid port ${String(entry.port)} for ${host}`);
    }
  }
  return { host, ip, ...(entry.port !== undefined ? { port: entry.port } : {}) };
}

/** Prints the INPUT and OUTPUT chains of both families, for {@link assertEgressLocked}. */
const EGRESS_REPORT = [
  'echo "v4:"; iptables -S OUTPUT; iptables -S INPUT',
  'echo "v6:"; { ip6tables -S OUTPUT && ip6tables -S INPUT; } 2>/dev/null || echo "v6-unavailable"',
  'echo "v6disabled=$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 0)"',
];

/** Docker's embedded resolver, reached over loopback on a user-defined network. */
const EMBEDDED_RESOLVER = '127.0.0.11';

const BASELINE_CHAIN = 'ASW_BASELINE';
const PRIVATE_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const PRIVATE_V6 = [
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '2002::/16',
];

export function baselineRules(
  allow: BaselineAllow[],
  cidrs: string[],
  blockPrivate = true,
  blockMetadata = true
): { v4: string[]; v6: string[] } {
  for (const entry of allow) {
    checkEgressEntry({ host: entry.ip, ...(entry.port === undefined ? {} : { port: entry.port }) });
    if (
      !isIP(entry.ip) ||
      (entry.protocol !== undefined && entry.protocol !== 'tcp' && entry.protocol !== 'udp')
    ) {
      throw new Error('baseline: invalid allow rule');
    }
  }
  for (const cidr of cidrs) {
    const [ip = '', prefix] = cidr.split('/');
    const family = isIP(ip);
    if (
      !family ||
      cidr.split('/').length > 2 ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
    ) {
      throw new Error('baseline: invalid CIDR');
    }
  }
  const rules = (family: number) => [
    '-o lo -j ACCEPT',
    '-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    ...(blockMetadata
      ? (family === 4
          ? ['169.254.169.254', '169.254.170.2', ...METADATA_V4]
          : ['fd00:ec2::254']
        ).map((ip) => `-d ${ip} -j REJECT`)
      : []),
    ...(blockPrivate
      ? [
          ...allow
            .filter((e) => isIP(e.ip) === family)
            .map(
              (e) =>
                `-d ${e.ip}${e.port === undefined ? '' : ` -p ${e.protocol ?? 'tcp'} -m ${e.protocol ?? 'tcp'} --dport ${e.port}`} -j ACCEPT`
            ),
          ...cidrs
            .filter((c) => isIP(c.split('/')[0] ?? '') === family)
            .map((c) => `-d ${c} -j ACCEPT`),
          ...(family === 4 ? PRIVATE_V4 : PRIVATE_V6).map((c) => `-d ${c} -j REJECT`),
        ]
      : []),
  ];
  return { v4: rules(4), v6: rules(6) };
}

export function buildBaselineEgressScript(
  allow: BaselineAllow[],
  cidrs: string[],
  blockPrivate = true,
  blockMetadata = true,
  bootstrapDns: string[] = []
): string {
  if (bootstrapDns.some((server) => isIP(server) === 0)) {
    throw new Error('baseline: bootstrap DNS server must be an IP');
  }
  const { v4, v6 } = baselineRules(allow, cidrs, blockPrivate, blockMetadata);
  const install = (tool: string, rules: string[]) => [
    `${tool} -N ${BASELINE_CHAIN}`,
    ...rules.map((r) => `${tool} -A ${BASELINE_CHAIN} ${r}`),
    `${tool} -I OUTPUT 1 -j ${BASELINE_CHAIN}`,
  ];
  return [
    ...(bootstrapDns.length > 0
      ? [
          'set -eu',
          'if ! command -v iptables >/dev/null 2>&1 || ! command -v ip6tables >/dev/null 2>&1; then',
          'asw_dns=$(cat /etc/resolv.conf)',
          `trap 'printf "%s\\n" "$asw_dns" > /etc/resolv.conf' EXIT`,
          `printf '%s\\n' ${shellQuote(bootstrapDns.map((server) => `nameserver ${server}`).join('\n'))} > /etc/resolv.conf`,
          ...IPTABLES_PRELUDE,
          'printf "%s\\n" "$asw_dns" > /etc/resolv.conf',
          'trap - EXIT',
          'fi',
        ]
      : IPTABLES_PRELUDE),
    'v6=1',
    'if ! ip6tables -S OUTPUT >/dev/null 2>&1; then',
    'v6=0',
    '[ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 0)" = 1 ] || { echo "baseline: ip6tables unusable and IPv6 enabled" >&2; exit 1; }',
    'fi',
    ...install('iptables', v4),
    'if [ "$v6" = 1 ]; then',
    ...install('ip6tables', v6),
    'fi',
    `echo "v4:"; iptables -S OUTPUT; iptables -S ${BASELINE_CHAIN}`,
    `echo "v6:"; if [ "$v6" = 1 ]; then ip6tables -S OUTPUT; ip6tables -S ${BASELINE_CHAIN}; else echo "v6-unavailable"; fi`,
    'echo "v6disabled=$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 0)"',
  ].join('\n');
}

type BaselineAllow = ResolvedAllow & { protocol?: 'tcp' | 'udp' };

function normalizeBaselineRule(rule: string): string {
  return rule
    .replace(/ -d (?:0\.0\.0\.0|::)\/0(?= |$)/g, '')
    .replace(/ --reject-with \S+/g, '')
    .replace(/RELATED,ESTABLISHED|ESTABLISHED,RELATED/g, 'ESTABLISHED,RELATED')
    .replace(/-d (\S+)/g, (_, address: string) => {
      const [ip, prefix] = address.split('/');
      const family = isIP(ip ?? '');
      const bits = family === 6 ? 128 : 32;
      const length = prefix === undefined ? bits : Number(prefix);
      let value: bigint;
      if (family === 6) {
        const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1);
        const [head = '', tail = ''] = canonical.split('::');
        const left = head ? head.split(':') : [];
        const right = tail ? tail.split(':') : [];
        const groups = canonical.includes('::')
          ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
          : left;
        value = BigInt(`0x${groups.map((g) => g.padStart(4, '0')).join('')}`);
      } else {
        value = (ip ?? '').split('.').reduce((n, byte) => (n << 8n) | BigInt(byte), 0n);
      }
      const shift = BigInt(bits - length);
      return `-d ${family}:${((value >> shift) << shift).toString(16)}/${length}`;
    });
}

export function assertBaselineEgress(
  output: string,
  allow: BaselineAllow[],
  cidrs: string[],
  blockPrivate = true,
  blockMetadata = true
): void {
  const expected = baselineRules(allow, cidrs, blockPrivate, blockMetadata);
  for (const family of ['v4', 'v6'] as const) {
    const section =
      new RegExp(`${family}:\\n([\\s\\S]*?)(?:v6:|v6disabled=|$)`).exec(output)?.[1] ?? '';
    if (
      family === 'v6' &&
      section.includes('v6-unavailable') &&
      /v6disabled=1(?:\n|$)/.test(output)
    ) {
      continue;
    }
    const lines = section.trim().split('\n');
    const outputRules = lines.filter((l) => l.startsWith('-A OUTPUT '));
    const actual = lines
      .filter((l) => l.startsWith(`-A ${BASELINE_CHAIN} `))
      .map(normalizeBaselineRule);
    const wanted = expected[family].map((r) => normalizeBaselineRule(`-A ${BASELINE_CHAIN} ${r}`));
    if (
      !lines.includes('-P OUTPUT ACCEPT') ||
      outputRules[0] !== `-A OUTPUT -j ${BASELINE_CHAIN}` ||
      JSON.stringify(actual) !== JSON.stringify(wanted)
    ) {
      throw new Error(`baseline egress: ${family} kernel rules do not match the required baseline`);
    }
  }
}

/** An address the lock may name in a rule: an IP literal that is not on the forbidden list. */
function checkRuleAddress(rule: ResolvedAllow): void {
  if (isIP(rule.ip) === 0) {
    throw new Error(`egress allow entry: ${JSON.stringify(rule.ip)} is not an IP address`);
  }
  if (isForbiddenAllowAddress(rule.ip)) {
    throw new Error(`egress allow entry: ${rule.ip} is a refused address`);
  }
  if (
    rule.port !== undefined &&
    (!Number.isInteger(rule.port) || rule.port < 1 || rule.port > 65535)
  ) {
    throw new Error(`egress allow entry: invalid port ${String(rule.port)} for ${rule.ip}`);
  }
}

/**
 * `sh` script that installs default-deny egress in the shared network namespace. It receives IP
 * literals only: names are resolved on the worker ({@link resolveEgressTargets}) and pinned in the
 * workspace's `/etc/hosts`, so neither the helper nor the workspace needs DNS and none is opened.
 *
 * Rules, in order: the embedded resolver (`127.0.0.11`, matched by its original destination too,
 * because Docker DNATs it to a local port before the filter table sees it) is refused BEFORE the
 * loopback accept, so it cannot be used as a DNS tunnel; loopback is accepted; one ACCEPT per
 * allowed address; the `DROP` policies come last. INPUT accepts only loopback and
 * `ESTABLISHED,RELATED` (replies to the workspace's own flows); OUTPUT accepts no conntrack state,
 * so a connection initiated from outside, or one that predates the lock, cannot be used as a relay.
 * Conntrack is flushed best-effort afterwards (the flush only; no rule is ever best-effort). IPv6
 * gets the same treatment; a namespace where `ip6tables` is unusable is accepted only when IPv6
 * is disabled there, in which case v6 allow entries are skipped (unreachable by design).
 *
 * Pure: returns the script text, so it is testable without a daemon.
 */
export function buildEgressLockScript(
  allow: ResolvedAllow[],
  incoming: ResolvedAllow[] = []
): string {
  allow.forEach(checkRuleAddress);
  incoming.forEach((entry) => {
    checkRuleAddress(entry);
    if (entry.port === undefined) {
      throw new Error('egress lock: an incoming connection needs a port');
    }
  });
  const lines = [
    ...IPTABLES_PRELUDE,
    // allow_ip IP PORT: one ACCEPT rule in the right address family.
    'allow_ip() {',
    '  case "$1" in',
    '    *:*)',
    '      [ "$v6" = 1 ] || { echo "egress lock: skipping $1 (IPv6 disabled)" >&2; return 0; }',
    '      t=ip6tables ;;',
    '    *) t=iptables ;;',
    '  esac',
    '  if [ -n "$2" ]; then "$t" -A OUTPUT -d "$1" -p tcp --dport "$2" -j ACCEPT;',
    '  else "$t" -A OUTPUT -d "$1" -j ACCEPT; fi',
    '}',
    'v6=1',
    'if ! ip6tables -F OUTPUT 2>/dev/null || ! ip6tables -F INPUT 2>/dev/null; then',
    '  v6=0',
    '  [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 0)" = 1 ] || ' +
      '{ echo "egress lock: ip6tables unusable and IPv6 enabled" >&2; exit 1; }',
    'fi',
    'iptables -F OUTPUT',
    'iptables -F INPUT',
    // The embedded resolver is refused before loopback is accepted.
    `iptables -A OUTPUT -d ${EMBEDDED_RESOLVER} -p tcp -j REJECT`,
    `iptables -A OUTPUT -d ${EMBEDDED_RESOLVER} -p udp -j REJECT`,
    `iptables -A OUTPUT -m conntrack --ctorigdst ${EMBEDDED_RESOLVER} -j REJECT`,
    'iptables -A OUTPUT -o lo -j ACCEPT',
    'iptables -A INPUT -i lo -j ACCEPT',
    'iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'if [ "$v6" = 1 ]; then',
    '  ip6tables -A OUTPUT -o lo -j ACCEPT',
    '  ip6tables -A INPUT -i lo -j ACCEPT',
    '  ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'fi',
    ...allow.map((e) => `allow_ip ${shellQuote(e.ip)} ${shellQuote(String(e.port ?? ''))}`),
    ...incoming.flatMap(({ ip, port }) => {
      const table = ip.includes(':') ? '[ "$v6" = 0 ] || ip6tables' : 'iptables';
      return [
        `${table} -A INPUT -s ${shellQuote(ip)} -p tcp --dport ${port} -m conntrack --ctstate NEW -j ACCEPT`,
        `${table} -A OUTPUT -d ${shellQuote(ip)} -p tcp --sport ${port} -m conntrack --ctstate ESTABLISHED -j ACCEPT`,
      ];
    }),
    'iptables -P OUTPUT DROP',
    'iptables -P INPUT DROP',
    '[ "$v6" = 0 ] || { ip6tables -P OUTPUT DROP; ip6tables -P INPUT DROP; }',
    // Forget pre-lock connections so none of them counts as ESTABLISHED. The flush alone is
    // best-effort: the tool is absent from most images, and every rule above is already in force.
    'if command -v conntrack >/dev/null 2>&1; then conntrack -F >/dev/null 2>&1 || true; fi',
    // Read the policies back from the kernel in the same run: once the lock is in, the helper
    // can no longer fetch iptables, so a second verification container could not start.
    ...EGRESS_REPORT,
  ];
  return lines.join('\n');
}

/** What {@link resolveEgressTargets} hands the lock: the rules, and the names to pin. */
export interface EgressTargets {
  rules: ResolvedAllow[];
  /** `[ip, hostname]` pairs to append to the workspace's `/etc/hosts`. */
  hosts: Array<[string, string]>;
}

/** Parse `/etc/hosts` text into name -> addresses. */
function parseHostsFile(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of text.split('\n')) {
    const [ip, ...names] = raw.replace(/#.*/, '').trim().split(/\s+/);
    if (!ip || isIP(ip) === 0) {
      continue;
    }
    for (const name of names) {
      const key = name.toLowerCase();
      out.set(key, [...(out.get(key) ?? []), ip]);
    }
  }
  return out;
}

/**
 * Turn allow entries into IP-only rules. `resolve` answers a name the way the WORKSPACE would see
 * it (see {@link resolveInWorkspace}); it is asked once per name, so two ports for one name get
 * the same answer, and the rules and the `/etc/hosts` lines come from that one set. `trusted` holds
 * the names the worker itself pinned with `--add-host` (the worker alias) and their addresses: they
 * are honoured as given and need no new line. Every address, resolved or literal, must clear
 * {@link isForbiddenAllowAddress}, and a name with no address is refused: the workspace is given
 * no DNS to fall back on.
 */
export async function resolveEgressTargets(
  allow: EgressAllowEntry[],
  resolve: (host: string) => Promise<string[]>,
  trusted: Map<string, string[]> = new Map()
): Promise<EgressTargets> {
  const rules: ResolvedAllow[] = [];
  const hosts: Array<[string, string]> = [];
  const answers = new Map<string, string[]>();
  for (const entry of allow) {
    const { host, port, ip } = checkEgressEntry(entry);
    const portPart = port === undefined ? {} : { port };
    if (ip) {
      rules.push({ ip: host, ...portPart });
      continue;
    }
    const key = host.toLowerCase();
    let addresses = answers.get(key);
    if (!addresses) {
      const pinned = trusted.get(key);
      const found = [...new Set(pinned ?? (await resolve(host)))];
      if (found.length === 0) {
        throw new Error(`egress allow entry ${host} resolved to no address`);
      }
      for (const address of found) {
        if (isForbiddenAllowAddress(address)) {
          throw new Error(`egress allow entry ${host} resolves to a refused address (${address})`);
        }
        if (!pinned) {
          hosts.push([address, host]);
        }
      }
      answers.set(key, found);
      addresses = found;
    }
    for (const address of addresses) {
      rules.push({ ip: address, ...portPart });
    }
  }
  rules.forEach(checkRuleAddress);
  return { hosts, rules };
}

/** `::ffff:1.2.3.4` (what glibc's `getent hosts` prints for an IPv4 answer) back to `1.2.3.4`. */
function unmapV4(address: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m?.[1] && isIP(m[1]) === 4 ? m[1] : address;
}

/** Addresses from `getent` output: the first column of each line, valid and de-duplicated. */
function parseGetent(stdout: string): string[] {
  const out = new Set<string>();
  for (const line of stdout.split('\n')) {
    const first = line.trim().split(/\s+/)[0];
    if (first && isIP(first) !== 0) {
      out.add(unmapV4(first));
    }
  }
  return [...out];
}

/** The worker's own hostname, short and fully qualified: a name the worker answers for itself. */
function isWorkerOwnName(host: string): boolean {
  const own = os.hostname().toLowerCase();
  const name = host.toLowerCase();
  return name === own || name === own.split('.')[0];
}

/**
 * Resolve one non-literal name the way the workspace will: with a root `docker exec` of
 * `getent ahosts <name>` (falling back to `getent hosts` where the libc has no `ahosts`) inside the
 * workspace, BEFORE the lock, so the answer comes from the workspace's own network and embedded DNS,
 * not the worker's. The name has already passed the strict hostname regex and travels as one argv
 * element; no shell sees it. Two refusals:
 *  - a name the workspace's `/etc/hosts` already maps (other than the trusted alias) is refused:
 *    a service container started before the lock shares that file, and `getent` reads it before
 *    DNS, so the answer could be a planted one;
 *  - `getent` itself missing from the image falls back to the worker-side lookup, EXCEPT for the
 *    worker's own hostname, which is exactly the name the worker and the workspace resolve
 *    differently (several networks vs one). A name `getent` says does not exist is final.
 * Returns the addresses; the caller refuses an empty answer.
 */
export async function resolveInWorkspace(
  containerId: string,
  host: string,
  mapped: Map<string, string[]>,
  lookup: (host: string) => Promise<string[]> = async (name) =>
    (await dns.lookup(name, { all: true })).map((a) => a.address),
  asRoot = true
): Promise<string[]> {
  if (mapped.has(host.toLowerCase())) {
    throw new Error(
      `egress allow entry ${host}: the workspace /etc/hosts already maps this name; refusing it`
    );
  }
  let missing = false;
  for (const db of ['ahosts', 'hosts']) {
    const r = await spawnCaptureAsync(
      'docker',
      ['exec', ...(asRoot ? ['-u', 'root'] : []), containerId, 'getent', db, host],
      { heartbeatLabel: `workspace: resolving ${host}`, timeoutMs: 30_000 }
    );
    if (r.exitCode === 0) {
      const found = parseGetent(r.stdout);
      if (found.length > 0) {
        return found;
      }
      continue;
    }
    // 126/127 or the runtime's own message: no `getent`. 2: the name does not exist. Anything
    // else (an `ahosts` the libc does not know exits 1 with usage text) tries the next database.
    if (
      r.exitCode === 126 ||
      r.exitCode === 127 ||
      /executable file not found|not found/i.test(r.stderr)
    ) {
      missing = true;
      break;
    }
    if (r.exitCode === 2 && db === 'hosts') {
      return [];
    }
  }
  if (!missing) {
    return [];
  }
  if (isWorkerOwnName(host)) {
    throw new Error(
      `egress allow entry ${host} is the worker's own name and the workspace image has no getent to resolve it from inside the workspace`
    );
  }
  // Documented fallback: no getent in the workspace, so the worker's answer is the only one there is.
  return lookup(host);
}

/**
 * Check the lock script's read-back output: the v4 INPUT and OUTPUT policies must be DROP, and so
 * must the v6 ones unless IPv6 is unavailable AND disabled in the namespace.
 */
export function assertEgressLocked(output: string): void {
  const v4 = /v4:\n([\s\S]*?)(?:v6:|$)/.exec(output)?.[1] ?? '';
  if (!/^-P OUTPUT DROP$/m.test(v4)) {
    throw new Error('egress lock: IPv4 OUTPUT policy is not DROP');
  }
  if (!/^-P INPUT DROP$/m.test(v4)) {
    throw new Error('egress lock: IPv4 INPUT policy is not DROP');
  }
  const v6 = /v6:\n([\s\S]*?)(?:v6disabled=|$)/.exec(output)?.[1] ?? '';
  const v6Locked = /^-P OUTPUT DROP$/m.test(v6) && /^-P INPUT DROP$/m.test(v6);
  const v6Off = /v6-unavailable/.test(v6) && /v6disabled=1/.test(output);
  if (!v6Locked && !v6Off) {
    throw new Error('egress lock: IPv6 INPUT/OUTPUT policy is not DROP');
  }
}

/**
 * The throwaway helper that runs `script` in the workspace's network namespace. Same shape as the
 * metadata sidecar: a separate container joins the namespace with `NET_ADMIN`, so the workspace
 * never holds it. The image is `metadataBlockImage` (`WORKSPACE_METADATA_BLOCK_IMAGE`, default
 * `alpine:3.20`): the one deployer-configured image that already runs with `NET_ADMIN`, and not
 * the executor image, which an admin can set per repository. Alpine has no iptables baked in, so
 * the script runs `apk add` when it is missing; that happens before the lock, over the workspace's
 * own network. Offline deployments point the variable at an image with iptables installed.
 */
export function buildEgressHelperCommand(
  containerName: string,
  image: string,
  script: string
): string {
  if (!WORKSPACE_NAME_RE.test(containerName)) {
    throw new Error(`egress lock: invalid workspace name ${JSON.stringify(containerName)}`);
  }
  return `docker run --rm ${workspaceLabelArgs().join(' ')} --network container:${containerName} --cap-add=NET_ADMIN --security-opt=no-new-privileges -- ${shellQuote(image)} sh -c ${shellQuote(script)}`;
}

/** The `--add-host` entry that makes the Docker host alias resolve to the host gateway. */
const workerHostEntry = () => `--add-host=${DOCKER_HOST_ALIAS}:host-gateway`;

async function workspaceResolutionContext(containerId: string, networkOwner = containerId) {
  const current = await spawnCaptureAsync('docker', ['exec', containerId, 'cat', '/etc/hosts'], {
    heartbeatLabel: 'workspace: reading hosts',
    timeoutMs: 30_000,
  });
  if (current.exitCode !== 0) {
    throw new Error('egress lock: cannot read the workspace /etc/hosts');
  }
  const mapped = parseHostsFile(current.stdout);
  // The file is trusted for ONE name: the worker alias, and only when the container spec says the
  // worker added it (`--add-host` is recorded in HostConfig.ExtraHosts). Docker writes it at
  // creation, so its FIRST line is the worker's; a later line for the same name is not.
  const trusted = new Map<string, string[]>();
  const inspected = await spawnCaptureAsync(
    'docker',
    ['inspect', '--format', '{{json .HostConfig.ExtraHosts}}', networkOwner],
    { heartbeatLabel: 'workspace: reading extra hosts', timeoutMs: 30_000 }
  );
  if (inspected.exitCode !== 0) {
    throw new Error('egress lock: cannot inspect the workspace extra hosts');
  }
  const alias = DOCKER_HOST_ALIAS.toLowerCase();
  const addedByWorker = (JSON.parse(inspected.stdout.trim() || 'null') as string[] | null)?.some(
    (h) => h.toLowerCase() === `${alias}:host-gateway`
  );
  const aliasAddress = mapped.get(alias)?.[0];
  if (addedByWorker && aliasAddress) {
    trusted.set(alias, [aliasAddress]);
    mapped.delete(alias);
  }
  return { hostsText: current.stdout, mapped, trusted };
}

export async function installBaselineEgress(
  spec: Pick<WorkspaceContainerSpec, 'name' | 'dns' | 'baselineAllow'>,
  proxyUrls?: string[],
  bootstrapDns?: string[],
  runc = false
): Promise<KataBaseline> {
  const infra = resolveWorkspaceInfra();
  const config: KataBaseline = {
    allow: [],
    blockMetadata: infra.blockMetadata,
    blockPrivate: infra.blockPrivateEgress,
    cidrs: infra.privateEgressAllow ?? [],
    privateRanges: PRIVATE_V4,
  };
  if (!infra.blockPrivateEgress && !infra.blockMetadata) {
    return config;
  }
  const allow: BaselineAllow[] = [];
  if (infra.blockPrivateEgress) {
    const { mapped, trusted } = await workspaceResolutionContext(spec.name);
    const resolve = (host: string) => resolveInWorkspace(spec.name, host, mapped);
    const proxies =
      proxyUrls ??
      [infra.harnessModelProxy, infra.registryProxy, infra.egressProxy].flatMap((proxy) =>
        proxy ? [proxy.url] : []
      );
    for (const proxy of proxies) {
      const url = new URL(proxy);
      const entry = {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      };
      allow.push(...(await resolveEgressTargets([entry], resolve, trusted)).rules);
    }
    for (const entry of spec.baselineAllow ?? []) {
      checkEgressEntry(entry);
      try {
        allow.push(...(await resolveEgressTargets([entry], resolve, trusted)).rules);
      } catch (error) {
        console.warn(
          `workspace ${spec.name}: skipping baseline host ${entry.host}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    for (const server of spec.dns) {
      if (isIP(server) === 0) {
        throw new Error('baseline: DNS server must be an IP');
      }
      for (const protocol of ['udp', 'tcp'] as const) {
        allow.push({ ip: server, port: 53, protocol });
      }
    }
  }
  const cidrs = infra.privateEgressAllow ?? [];
  const ranges = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const cidr of [...PRIVATE_V4, ...PRIVATE_V6]) {
    const [ip = '', prefix = '0'] = cidr.split('/');
    const family = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
    ranges[family].addSubnet(ip, Number(prefix), family);
  }
  const needed = allow.filter((e) => {
    const family = isIP(e.ip) === 4 ? 'ipv4' : 'ipv6';
    return ranges[family].check(e.ip, family);
  });
  const script = buildBaselineEgressScript(
    needed,
    cidrs,
    infra.blockPrivateEgress,
    infra.blockMetadata,
    bootstrapDns
  );
  const report = await execShellAsync(
    runc
      ? kataHelperCommand(spec.name, infra.metadataBlockImage, script)
      : buildEgressHelperCommand(spec.name, infra.metadataBlockImage, script),
    { heartbeatLabel: 'workspace: installing baseline egress' }
  );
  assertBaselineEgress(report, needed, cidrs, infra.blockPrivateEgress, infra.blockMetadata);
  return { ...config, allow: needed };
}

/**
 * Refuse to boot when the worker cannot reach the Docker API.
 *
 * Without this, an unreachable daemon still lets the worker start and accept
 * workflows, so the first symptom is `docker run` failing inside an activity —
 * after the run exists and has spent time. The usual causes are a worker process
 * whose groups do not include `docker` (a systemd user service, or one started
 * before the group was added) and a worker container that never received the
 * socket. Both surface here as the same connection error, and both are worth
 * refusing the boot over.
 */
export async function assertDockerDaemonReachable(): Promise<void> {
  const infra = resolveWorkspaceInfra();
  if (infra.backend !== 'docker') {
    return;
  }
  const socket = process.env.DOCKER_HOST?.trim() || 'unix:///var/run/docker.sock';
  try {
    await execShellAsync("docker info --format '{{.ServerVersion}}'", {
      heartbeatLabel: 'workspace: probing Docker API reachability',
    });
  } catch (cause) {
    throw new Error(
      `The Docker API could not be reached at ${socket}. A process that is not in the ` +
        '`docker` group — or a worker container whose socket is not mounted — fails exactly ' +
        'this way: add the worker user to `docker` and restart it, or mount ' +
        '/var/run/docker.sock (or point DOCKER_HOST at the proxy) and restart the container. ' +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause }
    );
  }
}

export async function assertDockerDiskLimit(): Promise<void> {
  const infra = resolveWorkspaceInfra();
  if (infra.backend !== 'docker' || !infra.diskLimit) {
    return;
  }
  try {
    await execShellAsync(
      `docker run --rm --storage-opt ${shellQuote(`size=${infra.diskLimit}`)} -- ${shellQuote(infra.metadataBlockImage)} true`,
      { heartbeatLabel: 'workspace: probing Docker disk quota' }
    );
    const name = `workspace-disk-probe-${randomUUID()}`;
    let created = false;
    try {
      await execShellAsync(
        `docker create --name ${name} ${workspaceLabelArgs().join(' ')} --storage-opt ${shellQuote(`size=${infra.diskLimit}`)} -- ${shellQuote(infra.metadataBlockImage)} true`,
        { heartbeatLabel: 'workspace: identifying Docker quota driver' }
      );
      created = true;
      const driver = (
        await execShellAsync(`docker inspect --format '{{.Driver}}' ${name}`, {
          heartbeatLabel: 'workspace: checking Docker quota driver',
        })
      ).trim();
      if (!['overlay2', 'devicemapper', 'btrfs', 'zfs'].includes(driver)) {
        throw new Error(
          `Unsupported Docker storage driver ${JSON.stringify(driver)}: size may be silently ignored`
        );
      }
    } finally {
      if (created) {
        await execShellAsync(`docker rm -f ${name}`, {
          heartbeatLabel: 'workspace: removing Docker quota probe',
        });
      }
    }
  } catch (cause) {
    throw new Error(
      `WORKSPACE_DISK_LIMIT cannot be enforced by Docker: overlay2 requires XFS with pquota; use a supported devicemapper, btrfs or zfs driver, or unset the limit. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
}

export function buildServiceContainerArgs(
  workspaceName: string,
  service: WorkspaceServiceSpec,
  kata?: KataNetworkGroup
): string[] {
  const envNames = Object.keys(service.env ?? {}).sort();
  return [
    'run',
    '-d',
    '--name',
    `${workspaceName}-svc-${service.name}`,
    ...dockerRuntimeArgs(),
    ...(kata?.childArgs() ?? []),
    '--label',
    `asw.workspace=${workspaceName}`,
    ...workspaceLabelArgs(),
    '--network',
    `container:${workspaceName}`,
    '--memory=512m',
    '--cpus=1',
    '--pids-limit=128',
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    ...(service.runAsUser === undefined
      ? [
          '--cap-add=CHOWN',
          '--cap-add=SETUID',
          '--cap-add=SETGID',
          '--cap-add=FOWNER',
          '--cap-add=DAC_OVERRIDE',
        ]
      : ['--user', `${service.runAsUser}:${service.runAsGroup ?? service.runAsUser}`]),
    ...envNames.flatMap((name) => ['-e', name]),
    '--',
    service.image,
  ];
}

/**
 * `sh` script that prints the PID of every direct child of PID 1, one per
 * line. Run inside the container immediately after `docker run`, when the
 * only child of `docker-init` is the `sleep infinity` keeper. Uses only
 * `/proc` and `sed`, which busybox and coreutils images both have.
 */
export function keeperPidProbeScript(): string {
  return [
    'asw_ppid() { sed -n \'s/^PPid:[[:space:]]*//p\' "/proc/$1/status" 2>/dev/null; }',
    'for asw_d in /proc/[0-9]*; do',
    '  asw_p=$(basename "$asw_d")',
    '  if [ "$(asw_ppid "$asw_p")" = 1 ]; then echo "$asw_p"; fi',
    'done',
  ].join('\n');
}

/**
 * The names of a `secretEnv`, validated by {@link assertSecretEnvName}. Each is
 * passed as `-e NAME` without a value, so docker resolves it from the client's
 * own environment and the value is never on a command line. A name also reaches
 * the shell string of the throwing exec path.
 */
function secretEnvNames(secretEnv: Record<string, string> | undefined): string[] {
  const names = Object.keys(secretEnv ?? {});
  for (const name of names) {
    assertSecretEnvName(name);
  }
  return names;
}

/**
 * The `docker exec` argv for one command in the container. A `secretEnv`
 * contributes names only; the caller hands the values to the docker client's
 * environment so `-e NAME` resolves against them.
 */
function execArgv(
  h: WorkspaceHandle,
  argv: string[],
  opts: {
    workdir?: string;
    env?: string[];
    secretEnv?: Record<string, string>;
    stdin?: boolean;
  }
): string[] {
  assertNoCredentialEnvPairs(opts.env, 'docker exec env');
  return [
    'exec',
    ...(opts.stdin ? ['-i'] : []),
    ...(opts.workdir ? ['-w', opts.workdir] : []),
    ...(opts.env ?? []).flatMap((pair) => ['-e', pair]),
    // Named without a value: docker resolves it from the client's environment.
    ...secretEnvFlags(opts.secretEnv),
    h.id,
    ...argv,
  ];
}

/**
 * The same invocation as a shell string, for the throwing exec path
 * (`execShellAsync` semantics). Identifiers the worker generated (container
 * id, env pairs) and the leading argv (`sh -c`) go unquoted as before; the
 * final argument — the script the caller supplied — is shell-quoted.
 */
function execCommand(h: WorkspaceHandle, argv: string[], opts: WorkspaceExecOptions): string {
  assertNoCredentialEnvPairs(opts.env, 'docker exec env');
  const parts = ['docker', 'exec'];
  if (opts.workdir) {
    parts.push('-w', opts.workdir);
  }
  for (const pair of opts.env ?? []) {
    parts.push('-e', pair);
  }
  for (const name of secretEnvNames(opts.secretEnv)) {
    parts.push('-e', shellQuote(name));
  }
  parts.push(h.id, ...argv.slice(0, -1), shellQuote(argv.at(-1) ?? ''));
  return parts.join(' ');
}

export function workspaceBootstrapScript(): string {
  return [
    'set -eu',
    'fail() { echo "workspace bootstrap: cannot install git/bash; provide them in the executor image" >&2; exit 1; }',
    'missing=""',
    'if [ ! -x /usr/bin/git ] && [ ! -x /bin/git ]; then missing="$missing git"; fi',
    'if [ ! -x /bin/bash ] && [ ! -x /usr/bin/bash ]; then missing="$missing bash"; fi',
    'if [ -n "$missing" ]; then',
    '  if [ -x /sbin/apk ]; then',
    '    /sbin/apk add --no-cache $missing || fail',
    '  elif [ -x /usr/bin/apt-get ]; then',
    '    /usr/bin/apt-get -o APT::Sandbox::User=root update && /usr/bin/apt-get -o APT::Sandbox::User=root install -y --no-install-recommends $missing || fail',
    '  else fail; fi',
    'fi',
    '[ -x /usr/bin/git ] || [ -x /bin/git ] || fail',
    '[ -x /bin/bash ] || [ -x /usr/bin/bash ] || fail',
  ].join('\n');
}

/**
 * The Docker driver: workspaces are `docker run`d containers kept alive by
 * `sleep infinity`, reached through `docker exec`, `docker cp` and
 * `docker pause`.
 *
 * Keeper PID: under `--init`, PID 1 is `docker-init` and the keeper is its
 * only child at start — create() records it then, before any exec can spawn
 * siblings that would confuse a later "lowest child of PID 1" guess. A
 * Kubernetes driver cannot reuse the trick (there `sleep` is itself PID 1 in
 * the pod, and the first agent process would look like the keeper — sparing
 * it would leave it alive to read the git credential off the command line),
 * which is why the PID is a creation-time driver output, not a per-call
 * computation.
 */
class DockerWorkspaceBackend implements WorkspaceBackend {
  readonly kind = 'docker' as const;
  private readonly egressPins = new Map<string, Map<string, string[]>>();
  private readonly kataGroups = new Map<string, KataNetworkGroup>();

  async clearSetupProcesses(
    h: WorkspaceHandle,
    script: string,
    mountNamespace: string
  ): Promise<void> {
    if (!/^mnt:\[\d+\]$/.test(mountNamespace)) {
      throw new Error('setup cleanup: invalid recorded mount namespace');
    }
    const check = `[ "$(readlink /proc/${h.keeperPid}/ns/mnt)" = ${shellQuote(mountNamespace)} ] || { echo 'setup cleanup: workspace PID namespace is not accessible to the trusted helper' >&2; exit 1; }`;
    await execShellAsync(
      [
        'docker',
        'run',
        '--rm',
        '--network=none',
        `--pid=container:${h.id}`,
        '--cap-drop=ALL',
        '--cap-add=KILL',
        '--cap-add=SYS_PTRACE',
        '--security-opt=no-new-privileges',
        '--read-only',
        '--memory=128m',
        '--pids-limit=64',
        '--',
        resolveWorkspaceInfra().metadataBlockImage,
        '/usr/bin/env',
        '-i',
        'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
        '/bin/sh',
        '-ec',
        `${check}\n${script}`,
      ]
        .map(shellQuote)
        .join(' '),
      {
        heartbeatLabel: 'workspace: verifying setup processes stopped',
        timeoutMs: 60_000,
      }
    );
  }
  private readonly bootstrapHandles = new Map<string, WorkspaceHandle>();
  private readonly bootstrapRunning = new Set<string>();

  private sealBootstrap(handle: WorkspaceHandle): void {
    if (this.bootstrapRunning.has(handle.id)) {
      throw new Error(
        'workspace bootstrap: ordinary execution is forbidden during root preparation'
      );
    }
    this.bootstrapHandles.delete(handle.id);
  }

  async bootstrapTools(handle: WorkspaceHandle): Promise<void> {
    if (this.bootstrapHandles.get(handle.id) !== handle || this.bootstrapRunning.has(handle.id)) {
      throw new Error(
        'workspace bootstrap: root execution is forbidden after preparation or ordinary execution'
      );
    }
    this.bootstrapRunning.add(handle.id);
    try {
      await execShellAsync(
        [
          'docker',
          'exec',
          '--user',
          '0',
          '--workdir',
          '/',
          '-e',
          'LD_PRELOAD=',
          '-e',
          'LD_LIBRARY_PATH=',
          '-e',
          'LD_AUDIT=',
          '-e',
          'ENV=',
          '-e',
          'BASH_ENV=',
          handle.id,
          '/usr/bin/env',
          '-i',
          'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
          'HOME=/root',
          '/bin/sh',
          '-ec',
          workspaceBootstrapScript(),
        ]
          .map(shellQuote)
          .join(' '),
        { heartbeatLabel: 'workspace: installing bootstrap tools', timeoutMs: 600_000 }
      );
    } finally {
      this.bootstrapRunning.delete(handle.id);
      this.bootstrapHandles.delete(handle.id);
    }
  }

  async create(spec: WorkspaceContainerSpec): Promise<WorkspaceHandle> {
    const infra = resolveWorkspaceInfra();
    assertNoCredentialEnvPairs(spec.env, 'docker run env');
    const secretNames = secretEnvNames(spec.secretEnv);
    let kata: KataNetworkGroup | undefined;
    if (!spec.trusted && usesKataNetwork()) {
      kata = new KataNetworkGroup(spec.name, infra.metadataBlockImage);
      this.kataGroups.set(spec.name, kata);
      try {
        const holderArgs = ephemeralNetworkHolderArgs(
          {
            cpus: spec.cpus,
            dns: spec.dns,
            image: infra.metadataBlockImage,
            memory: spec.memory,
            name: spec.name,
            network: 'egress',
            reachWorker: spec.reachWorker,
          },
          kata.holder
        );
        forceRunc(holderArgs);
        if (spec.network) {
          if (['host', 'none'].includes(spec.network) || spec.network.startsWith('container:')) {
            throw new Error('Kata network: unsupported holder network');
          }
          holderArgs[holderArgs.findIndex((arg) => arg.startsWith('--network='))] =
            `--network=${spec.network}`;
        }
        await kata.start(
          holderArgs,
          infra.runtime ?? '',
          { cpus: spec.cpus, memory: spec.memory },
          () =>
            installBaselineEgress({ ...spec, name: kata?.holder ?? '' }, undefined, undefined, true)
        );
      } catch (error) {
        await this.remove(spec.name);
        throw error;
      }
    }
    const storage = infra.diskLimit
      ? ` --storage-opt ${shellQuote(`size=${infra.diskLimit}`)}`
      : '';
    const runtime = spec.trusted
      ? ''
      : dockerRuntimeArgs()
          .map((arg) => ` ${shellQuote(arg)}`)
          .join('');
    // Hardening notes (unlike the locked-down `ephemeralContainer` runner, this
    // workspace intentionally keeps default bridge networking and omits
    // `--read-only`/`--tmpfs`: the implementer agent needs outbound git
    // clone/push + package installs and writes freely to its own container
    // layer for the duration of the run):
    //  - `--memory`/`--cpus`/`--pids-limit` bound a runaway agent-driven build
    //    or test process instead of letting it exhaust the host.
    //  - `--cap-drop=ALL` + `--security-opt=no-new-privileges` remove Linux
    //    capabilities and privilege-escalation the workspace never needs.
    // A separate NET_ADMIN helper verifies the baseline before services start.
    const dns = kata ? '' : spec.dns.map((server) => `--dns=${shellQuote(server)}`).join(' ');
    const addHosts = kata
      ? ''
      : [
          '--add-host=metadata.google.internal:0.0.0.0',
          '--add-host=metadata.gke.internal:0.0.0.0',
          ...(spec.reachWorker ? [workerHostEntry()] : []),
        ].join(' ');
    const network = kata
      ? ` --network=${shellQuote(`container:${kata.holder}`)} ${kata.childArgs().map(shellQuote).join(' ')}`
      : spec.network
        ? ` --network=${shellQuote(spec.network)}`
        : '';
    // A creation-time secret is named (`-e NAME`) and its value handed to the
    // docker client in its environment, so it is on no command line and in no
    // error text that echoes one.
    const env = [
      ...(spec.env ?? []).map((pair) => ` -e ${shellQuote(pair)}`),
      ...secretNames.map((name) => ` -e ${name}`),
      ...(infra.runAsRoot ? [] : [' -e HOME=/workspace/.home']),
    ].join('');
    const user = infra.runAsRoot ? '' : ' --user 1000:1000';
    // `memory` is a config string, so shell-quote it (the numeric caps can't
    // carry shell metacharacters); '--' separates docker flags from the image.
    try {
      await execShellAsync(
        `docker run -d --name ${spec.name} ${workspaceLabelArgs().join(' ')} --init${user} ${dns} --memory=${shellQuote(spec.memory)} --cpus=${spec.cpus} --pids-limit=${spec.pidsLimit}${storage}${runtime} --cap-drop=ALL --security-opt=no-new-privileges ${addHosts}${network}${env} -- ${shellQuote(spec.image)} sleep infinity`,
        {
          heartbeatLabel: 'workspace: starting container',
          ...(spec.secretEnv ? { env: spec.secretEnv } : {}),
        }
      );

      // Record the keeper PID now, while the `sleep infinity` under `--init` is
      // provably the only child of PID 1 — before the first exec can leave a
      // sibling behind. Zero or multiple candidates mean the image cannot run
      // the keeper contract (`sleep infinity` under an init) or something raced
      // in, so creation fails closed.
      const probe = await execShellAsync(
        `docker exec ${spec.name} sh -c ${shellQuote(keeperPidProbeScript())}`,
        { heartbeatLabel: 'workspace: identifying keeper process' }
      );
      const candidates = probe
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line))
        .map(Number);
      if (candidates.length !== 1) {
        throw new Error(
          `workspace ${spec.name}: expected exactly one keeper process (the child of PID 1), ` +
            `found ${candidates.length} — the image must run \`sleep infinity\` under an init`
        );
      }
      const keeperPid = candidates[0] ?? 0;
      const handle: WorkspaceHandle = { id: spec.name, keeperPid };

      try {
        if (!infra.runAsRoot) {
          await this.prepareWorkspaceDirectories(handle);
        }
        this.bootstrapHandles.set(handle.id, handle);
        await this.bootstrapTools(handle);
        if (!kata) {
          await installBaselineEgress(spec);
        }
      } catch (error) {
        await execShellAsync(`docker rm -f ${shellQuote(spec.name)}`, {
          heartbeatLabel: 'workspace: removing unsafe container',
        });
        throw error;
      }

      for (const service of spec.services ?? []) {
        if (!/^[a-z][a-z0-9-]{0,30}$/.test(service.name)) {
          throw new Error(`invalid workspace service name: ${service.name}`);
        }
        const serviceName = `${spec.name}-svc-${service.name}`;
        const env = service.env ?? {};
        for (const name of Object.keys(env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new Error(`invalid service environment name: ${name}`);
          }
        }
        await execShellAsync(
          ['docker', ...buildServiceContainerArgs(spec.name, service, kata)]
            .map(shellQuote)
            .join(' '),
          {
            heartbeatLabel: `workspace: starting service ${service.name}`,
            ...(Object.keys(env).length > 0 ? { env } : {}),
          }
        );
        if (service.readyCommand) {
          const deadline = Date.now() + 120_000;
          let ready = false;
          while (Date.now() < deadline) {
            try {
              await execShellAsync(
                `docker exec ${shellQuote(serviceName)} sh -c ${shellQuote(service.readyCommand)}`,
                {
                  heartbeatLabel: `workspace: waiting for service ${service.name}`,
                  timeoutMs: 15_000,
                }
              );
              ready = true;
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }
          if (!ready) {
            throw new Error(
              `workspace service ${service.name} did not become ready within 120000ms`
            );
          }
        }
      }

      return handle;
    } catch (error) {
      if (kata) {
        await this.remove(spec.name);
      }
      throw error;
    }
  }

  private async prepareWorkspaceDirectories(handle: WorkspaceHandle): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-dirs-'));
    try {
      const workspace = path.join(dir, 'workspace');
      await fs.mkdir(path.join(workspace, '.home'), { recursive: true });
      await fs.mkdir(path.join(workspace, 'target-repo'));
      // Archive-mode imports use the container's configured UID/GID in the Docker daemon.
      const copied = await spawnCaptureAsync('docker', ['cp', '-a', workspace, `${handle.id}:/`], {
        heartbeatLabel: 'workspace: preparing writable directories',
        timeoutMs: 120_000,
      });
      if (copied.exitCode !== 0) {
        throw new Error(`workspace: preparing UID 1000 directories failed: ${copied.stderr}`);
      }
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  }

  attach(id: string, keeperPid = 0): WorkspaceHandle {
    return { id, keeperPid };
  }

  async exec(
    h: WorkspaceHandle,
    argv: string[],
    opts: WorkspaceExecOptions
  ): Promise<CapturedResult> {
    this.sealBootstrap(h);
    const args = execArgv(h, argv, { ...opts, stdin: opts.stdin !== undefined });
    const runOpts = {
      heartbeatLabel: opts.heartbeatLabel,
      ...(opts.maxOutputBytes !== undefined ? { maxBuffer: opts.maxOutputBytes } : {}),
      onTimeout: opts.onTimeout,
      ...(opts.secretEnv ? { env: opts.secretEnv } : {}),
      timeoutMs: opts.timeoutMs ?? 600_000,
    };
    return opts.stdin !== undefined
      ? spawnWithStdinAsync('docker', args, opts.stdin, runOpts)
      : spawnCaptureAsync('docker', args, runOpts);
  }

  async execShell(h: WorkspaceHandle, argv: string[], opts: WorkspaceExecOptions): Promise<string> {
    this.sealBootstrap(h);
    return execShellAsync(execCommand(h, argv, opts), {
      heartbeatLabel: opts.heartbeatLabel,
      onTimeout: opts.onTimeout,
      ...(opts.secretEnv ? { env: opts.secretEnv } : {}),
      timeoutMs: opts.timeoutMs,
    });
  }

  spawn(h: WorkspaceHandle, argv: string[], opts: WorkspaceSpawnOptions) {
    this.sealBootstrap(h);
    assertNoCredentialEnvPairs(opts.env, 'docker exec env');
    const args = [
      'exec',
      ...(opts.stdin ? ['-i'] : []),
      ...(opts.workdir ? ['-w', opts.workdir] : []),
      ...(opts.env ?? []).flatMap((pair) => ['-e', pair]),
      // Named without a value: docker reads it from its own environment below,
      // so a secret never appears on a command line or in `ps`.
      ...secretEnvFlags(opts.secretEnv),
      h.id,
      ...argv,
    ];
    return spawn('docker', args, {
      env: { ...process.env, ...opts.secretEnv },
      signal: opts.signal,
      stdio: opts.stdio,
    });
  }

  copyOut(
    h: WorkspaceHandle,
    path: string,
    destTarFile: string,
    opts?: { maxBytes?: number; timeoutMs?: number; heartbeatLabel?: string }
  ): Promise<CappedFileResult> {
    // The daemon produces the archive, not the container's `tar`. The size cap
    // is enforced while the archive streams to disk: a sparse file expands in
    // full in `docker cp`'s output, so measuring afterwards is too late.
    return spawnToFileCapped('docker', ['cp', `${h.id}:${path}`, '-'], destTarFile, {
      heartbeatLabel: opts?.heartbeatLabel ?? 'workspace: copying out',
      maxBytes: opts?.maxBytes ?? Number.MAX_SAFE_INTEGER,
      timeoutMs: opts?.timeoutMs,
    });
  }

  copyIn(h: WorkspaceHandle, srcTarFile: string, path: string): Promise<void> {
    return execShellAsync(
      `docker cp ${resolveWorkspaceInfra().runAsRoot ? '' : '-a '}- ${shellQuote(`${h.id}:${path}`)} < ${shellQuote(srcTarFile)}`,
      { heartbeatLabel: 'workspace: copying in', timeoutMs: 600_000 }
    ).then(() => undefined);
  }

  copyFileIn(
    h: WorkspaceHandle,
    srcFile: string,
    path: string,
    opts?: { timeoutMs?: number; heartbeatLabel?: string }
  ): Promise<CapturedResult> {
    return spawnCaptureAsync(
      'docker',
      ['cp', ...(resolveWorkspaceInfra().runAsRoot ? [] : ['-a']), srcFile, `${h.id}:${path}`],
      {
        heartbeatLabel: opts?.heartbeatLabel ?? 'workspace: copying a file in',
        timeoutMs: opts?.timeoutMs ?? 120_000,
      }
    );
  }

  pause(h: WorkspaceHandle): Promise<void> {
    return execShellAsync(`docker pause ${shellQuote(h.id)}`, {
      heartbeatLabel: 'workspace: freezing the container',
      timeoutMs: 30_000,
    }).then(() => undefined);
  }

  async remove(idOrHandle: string | WorkspaceHandle): Promise<void> {
    const id = typeof idOrHandle === 'string' ? idOrHandle : idOrHandle.id;
    this.egressPins.delete(id);
    const kata = this.kataGroups.get(id);
    for (const [key, group] of this.kataGroups) {
      if (key === id || group === kata) {
        this.kataGroups.delete(key);
      }
    }
    try {
      let owner = id;
      if (/^[a-f0-9]{64}$/i.test(id)) {
        const inspected = await spawnCaptureAsync(
          'docker',
          ['inspect', '--format', '{{.Name}}', id],
          { heartbeatLabel: 'workspace: resolving container name', timeoutMs: 30_000 }
        );
        const name = inspected.stdout.trim().replace(/^\//, '');
        if (inspected.exitCode === 0 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) {
          owner = name;
        }
      }
      const sidecars = await spawnCaptureAsync(
        'docker',
        ['ps', '-aq', '--filter', `label=asw.workspace=${owner}`],
        { heartbeatLabel: 'workspace: finding service containers', timeoutMs: 30_000 }
      );
      const ids = sidecars.stdout.split(/\s+/).filter((value) => /^[a-f0-9]+$/i.test(value));
      if (ids.length > 0) {
        await spawnCaptureAsync('docker', ['rm', '-f', ...ids], {
          heartbeatLabel: 'workspace: removing service containers',
          timeoutMs: 60_000,
        });
      }
    } catch {
      /* already gone */
    }
    try {
      await execShellAsync(`docker rm -f ${id}`);
    } catch {
      /* already gone */
    }
    if (kata) {
      await kata.destroy();
    }
  }

  /**
   * Remove workspace containers no live activity can still own. Selection is
   * by the marker label alone, so nothing else on the host is touched, and by
   * age past the longest lifetime a workspace can have (`DOCKER_WORKSPACE_MAX_AGE_MS`)
   * rather than by anything in this process, so a young container started by
   * another worker on the same daemon is never a candidate. Never throws.
   */
  async reapOrphans(now: Date): Promise<WorkspaceReapResult> {
    const result: WorkspaceReapResult = { failed: [], removed: [], scanned: 0 };
    let stdout: string;
    try {
      const listed = await spawnCaptureAsync('docker', dockerListArgs(), {
        heartbeatLabel: 'workspace reaper: listing containers',
        timeoutMs: 60_000,
      });
      if (listed.exitCode !== 0) {
        result.failed.push({ error: listed.stderr.trim() || 'docker ps failed', id: '(list)' });
        return result;
      }
      stdout = listed.stdout;
    } catch (err) {
      result.failed.push({ error: err instanceof Error ? err.message : String(err), id: '(list)' });
      return result;
    }
    const containers = parseDockerListing(stdout);
    result.scanned = containers.length;
    for (const container of selectExpiredContainers(containers, now).slice(
      0,
      MAX_REAPED_PER_SWEEP
    )) {
      try {
        const removed = await spawnCaptureAsync('docker', ['rm', '-f', '--', container.id], {
          heartbeatLabel: 'workspace reaper: removing container',
          timeoutMs: 60_000,
        });
        if (removed.exitCode === 0 || /no such container/i.test(removed.stderr)) {
          result.removed.push(container.id);
        } else {
          result.failed.push({
            error: removed.stderr.trim() || `docker rm exited ${removed.exitCode}`,
            id: container.id,
          });
        }
      } catch (err) {
        result.failed.push({
          error: err instanceof Error ? err.message : String(err),
          id: container.id,
        });
      }
    }
    return result;
  }

  async createVolume(name: string): Promise<void> {
    await execShellAsync(`docker volume create ${shellQuote(name)}`, {
      heartbeatLabel: 'workspace: creating volume',
    }).then(() => undefined);
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await execShellAsync(`docker volume rm -f ${shellQuote(name)}`);
    } catch {
      /* already gone */
    }
  }

  async runEphemeral(
    spec: EphemeralContainerSpec,
    opts: EphemeralRunOptions
  ): Promise<CapturedResult> {
    if (spec.network !== 'egress' && !usesKataNetwork()) {
      return this.spawnEphemeral(spec, opts, false);
    }
    const named = { ...spec, name: spec.name ?? `shellstep-${randomUUID()}` };
    try {
      const holder = await this.prepareEphemeralNetwork(named);
      return await this.spawnEphemeral(named, opts, false, holder);
    } finally {
      await this.remove(named.name);
    }
  }

  private spawnEphemeral(
    spec: EphemeralContainerSpec,
    opts: EphemeralRunOptions,
    detached: boolean,
    holder?: string
  ): Promise<CapturedResult> {
    const args = ephemeralArgs(spec, detached, holder);
    const kata = spec.name ? this.kataGroups.get(spec.name) : undefined;
    if (kata) {
      args.splice(args.indexOf('--'), 0, ...kata.childArgs());
    }
    return spawnCaptureAsync('docker', args, {
      heartbeatLabel: opts.heartbeatLabel,
      ...(spec.secretEnv ? { env: spec.secretEnv } : {}),
      ...(!detached && opts.onStdoutLine ? { onStdoutLine: opts.onStdoutLine } : {}),
      timeoutMs: opts.timeoutMs ?? (detached ? 60_000 : undefined),
    });
  }

  private async prepareEphemeralNetwork(
    spec: EphemeralContainerSpec & { name: string }
  ): Promise<string> {
    const infra = resolveWorkspaceInfra();
    const kata = usesKataNetwork()
      ? new KataNetworkGroup(spec.name, infra.metadataBlockImage)
      : undefined;
    const holder = kata?.holder ?? `ephemeral-net-${randomUUID()}`;
    const dnsServers = spec.dns?.length ? spec.dns : infra.dns;
    const started = kata
      ? undefined
      : await spawnCaptureAsync(
          'docker',
          ephemeralNetworkHolderArgs({ ...spec, dns: dnsServers }, holder),
          {
            heartbeatLabel: 'step: starting network holder',
            timeoutMs: 60_000,
          }
        );
    if (started && started.exitCode !== 0) {
      throw new Error(`step network holder failed to start: ${started.stderr || started.stdout}`);
    }
    const origins = new Set(
      [
        ...(spec.env?.map((pair) => pair.slice(pair.indexOf('=') + 1)) ?? []),
        ...Object.values(spec.secretEnv ?? {}),
      ].flatMap((value) => {
        try {
          return [new URL(value).origin];
        } catch {
          return [];
        }
      })
    );
    const proxies = spec.reachWorker
      ? [infra.registryProxy, infra.egressProxy].flatMap((proxy) =>
          proxy && origins.has(new URL(proxy.url).origin) ? [proxy.url] : []
        )
      : [];
    const baseline = () =>
      installBaselineEgress(
        { dns: dnsServers, name: holder },
        proxies,
        dnsServers.includes('127.0.0.2') ? infra.dns : undefined,
        !!kata
      );
    if (kata) {
      this.kataGroups.set(spec.name, kata);
      this.kataGroups.set(holder, kata);
      const args = ephemeralNetworkHolderArgs(
        { ...spec, dns: dnsServers, network: 'egress' },
        holder
      );
      forceRunc(args);
      await kata.start(
        args,
        infra.runtime ?? '',
        { cpus: spec.cpus ?? 1, memory: spec.memory ?? '512m' },
        baseline
      );
      if (spec.network !== 'egress') {
        await kata.install();
      }
    } else {
      await baseline();
    }
    if (spec.egressPolicy === 'restricted') {
      try {
        if (!infra.egressProxy || !proxies.includes(infra.egressProxy.url)) {
          throw new Error('the step has no wired egress proxy');
        }
        const allow = proxies.map((proxy) => {
          const url = new URL(proxy);
          return {
            host: url.hostname.replace(/^\[|\]$/g, ''),
            port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
          };
        });
        await this.installEgressLock(this.attach(holder), allow, spec.publishPort);
      } catch (error) {
        throw egressPolicyFailure(
          `restricted step network lock could not be enforced: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return holder;
  }

  async startDetached(
    spec: EphemeralContainerSpec,
    opts: EphemeralRunOptions
  ): Promise<CapturedResult> {
    if (spec.network !== 'egress' && !usesKataNetwork()) {
      return this.spawnEphemeral(spec, opts, true);
    }
    const named = { ...spec, name: spec.name ?? `sidecar-${randomUUID()}` };
    try {
      const holder = await this.prepareEphemeralNetwork(named);
      const result = await this.spawnEphemeral(named, opts, true, holder);
      if (result.exitCode !== 0) {
        await this.remove(named.name);
      }
      return result;
    } catch (error) {
      await this.remove(named.name);
      throw error;
    }
  }

  async runHelper(spec: HelperContainerSpec, opts: EphemeralRunOptions): Promise<CapturedResult> {
    return spawnCaptureAsync('docker', helperArgs(spec), {
      heartbeatLabel: opts.heartbeatLabel,
      ...(spec.secretEnv ? { env: spec.secretEnv } : {}),
      ...(opts.maxOutputBytes ? { maxBuffer: opts.maxOutputBytes } : {}),
      timeoutMs: opts.timeoutMs,
    });
  }

  async containerLogs(name: string): Promise<CapturedResult> {
    return spawnCaptureAsync('docker', ['logs', name], {
      heartbeatLabel: 'container: collecting logs',
      timeoutMs: 10_000,
    });
  }

  canReachWorkerProxy(url: string): boolean {
    return new URL(url).hostname === DOCKER_HOST_ALIAS;
  }

  async lockEgress(
    handle: WorkspaceHandle,
    allow: EgressAllowEntry[],
    opts?: LockEgressOptions
  ): Promise<void> {
    try {
      this.egressPins.set(handle.id, await this.installEgressLock(handle, allow, undefined, opts));
    } catch (error) {
      if (usesKataNetwork()) {
        await this.remove(handle);
      }
      throw error;
    }
  }

  private async installEgressLock(
    handle: WorkspaceHandle,
    allow: EgressAllowEntry[],
    sidecarPort?: number,
    opts?: LockEgressOptions
  ): Promise<Map<string, string[]>> {
    // Fail closed: every error below propagates and the caller removes the workspace or holder.
    const image = resolveWorkspaceInfra().metadataBlockImage;
    // /etc/hosts belongs to the workspace container, not to its network namespace, so the helper
    // cannot write it. Post-setup pinning uses the daemon, never a root workspace exec.
    const kata = this.kataGroups.get(handle.id);
    if (usesKataNetwork() && !kata) {
      throw new Error('Kata network: workspace has no verified network group');
    }
    const { hostsText, mapped, trusted } = await workspaceResolutionContext(
      handle.id,
      kata?.holder
    );
    const prior = this.egressPins.get(handle.id) ?? new Map<string, string[]>();
    if (opts?.replace) {
      for (const [name, ips] of prior) {
        if (JSON.stringify(trusted.get(name) ?? mapped.get(name)) !== JSON.stringify(ips)) {
          throw new Error(`egress lock: workspace changed the recorded host pin for ${name}`);
        }
        trusted.set(name, ips);
      }
    }
    const { rules, hosts } = await resolveEgressTargets(
      allow,
      (host) => {
        if (opts?.replace && this.egressPins.has(handle.id)) {
          throw new Error(`egress lock: no prepared host pin for ${host}`);
        }
        return resolveInWorkspace(handle.id, host, mapped, undefined, !opts?.replace);
      },
      trusted
    );
    const incoming =
      sidecarPort === undefined
        ? []
        : (trusted.get(DOCKER_HOST_ALIAS) ?? []).map((ip) => ({ ip, port: sidecarPort }));
    if (sidecarPort !== undefined && incoming.length === 0) {
      throw new Error('egress lock: cannot identify the sidecar worker gateway');
    }
    const script = buildEgressLockScript(rules, incoming);
    if (hosts.length > 0) {
      const lines = hosts.map(([ip, name]) => `${ip}\t${name}\n`).join('');
      if (opts?.replace) {
        const inspected = await spawnCaptureAsync(
          'docker',
          ['inspect', '--format', '{{.Id}}\t{{.HostsPath}}', kata?.holder ?? handle.id],
          {
            heartbeatLabel: 'workspace: locating daemon-owned hosts file',
            timeoutMs: 30_000,
          }
        );
        const [containerId, hostsPath] = inspected.stdout.trim().split('\t');
        if (
          inspected.exitCode !== 0 ||
          !containerId ||
          !/^[a-f0-9]{64}$/.test(containerId) ||
          !hostsPath ||
          !path.posix.isAbsolute(hostsPath) ||
          /[,\r\n]/.test(hostsPath) ||
          !hostsPath.endsWith(`/${containerId}/hosts`)
        ) {
          throw new Error('egress lock: cannot locate the daemon-owned workspace hosts file');
        }
        const written = await spawnWithStdinAsync(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--network=none',
            '--user=0:0',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--read-only',
            '--memory=128m',
            '--pids-limit=64',
            '--mount',
            `type=bind,src=${hostsPath},dst=/asw-hosts`,
            '--',
            image,
            '/usr/bin/env',
            '-i',
            'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
            '/bin/sh',
            '-ec',
            'cat > /asw-hosts',
          ],
          `${hostsText}\n${lines}`,
          { heartbeatLabel: 'workspace: pinning egress hosts', timeoutMs: 30_000 }
        );
        if (written.exitCode !== 0) {
          throw new Error(
            `egress lock: cannot write the workspace /etc/hosts: ${written.stderr.trim()}`
          );
        }
        if (kata) {
          const expected = `${hostsText}\n${lines}`;
          const deadline = Date.now() + 5000;
          for (;;) {
            const visible = await spawnCaptureAsync(
              'docker',
              ['exec', handle.id, 'cat', '/etc/hosts'],
              {
                heartbeatLabel: 'workspace: verifying Kata host pins',
                timeoutMs: 30_000,
              }
            );
            if (visible.exitCode === 0 && visible.stdout === expected) {
              break;
            }
            if (visible.exitCode !== 0 || Date.now() >= deadline) {
              throw new Error(
                'egress lock: daemon-owned host pins are not visible in the Kata workspace'
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      } else {
        const written = await spawnWithStdinAsync(
          'docker',
          ['exec', '-i', '-u', 'root', handle.id, 'sh', '-c', 'cat >> /etc/hosts'],
          lines,
          { heartbeatLabel: 'workspace: pinning egress hosts', timeoutMs: 30_000 }
        );
        if (written.exitCode !== 0) {
          throw new Error('egress lock: cannot write the workspace /etc/hosts');
        }
      }
    }
    if (!opts?.prepareOnly) {
      if (kata) {
        await kata.install(undefined, rules, incoming);
      } else {
        const report = await execShellAsync(buildEgressHelperCommand(handle.id, image, script), {
          heartbeatLabel: 'workspace: locking egress',
        });
        assertEgressLocked(report);
      }
    }
    for (const [name, ips] of trusted) {
      prior.set(name, ips);
    }
    for (const [ip, name] of hosts) {
      const key = name.toLowerCase();
      prior.set(key, [...(prior.get(key) ?? []), ip]);
    }
    return prior;
  }

  async sidecarBaseUrl(name: string, containerPort: number): Promise<string> {
    const network = (
      await execShellAsync(
        `docker inspect --format '{{.HostConfig.NetworkMode}}' ${shellQuote(name)}`,
        {
          heartbeatLabel: 'workspace: resolving sidecar network',
        }
      )
    ).trim();
    const owner = network.startsWith('container:') ? network.slice('container:'.length) : name;
    const out = await execShellAsync(`docker port ${shellQuote(owner)} ${containerPort}/tcp`, {
      heartbeatLabel: 'workspace: resolving published port',
    });
    const m = /:(\d{1,5})\s*$/m.exec(out.trim());
    if (!m) {
      throw new Error(`could not resolve published port for ${name}:${containerPort}`);
    }
    return `http://127.0.0.1:${Number(m[1])}`;
  }
}

/**
 * `docker run` argv for one platform-authored helper container (the shell
 * step's git clone/finalize), byte-identical to what `shellStep.ts` emitted
 * inline: no lockdown flags, no name and no `--` separator. Author commands
 * never reach this path — they go through `runEphemeral`, which always applies
 * the lockdown.
 */
function helperArgs(spec: HelperContainerSpec): string[] {
  assertNoCredentialEnvPairs(spec.env, 'docker helper env');
  return [
    'run',
    '--rm',
    ...(spec.volumes ?? []).flatMap((v) => [
      '-v',
      `${v.source}:${v.target}:${v.readOnly ? 'ro' : 'rw'}`,
    ]),
    ...(spec.env ?? []).flatMap((pair) => ['-e', pair]),
    ...secretEnvFlags(spec.secretEnv),
    ...(spec.entrypoint ? ['--entrypoint', spec.entrypoint] : []),
    spec.image,
    ...(spec.argv ?? []),
  ];
}

export function dockerRuntimeArgs(): string[] {
  const runtime = resolveWorkspaceInfra().runtime;
  return runtime ? [`--runtime=${runtime}`] : [];
}

function usesKataNetwork(): boolean {
  const runtime = resolveWorkspaceInfra().runtime;
  return !!runtime && !['runc', 'runsc-host'].includes(runtime);
}

function forceRunc(args: string[]): void {
  const runtime = args.findIndex((arg) => arg.startsWith('--runtime='));
  if (runtime >= 0) {
    args[runtime] = '--runtime=runc';
  } else {
    args.splice(args.indexOf('--'), 0, '--runtime=runc');
  }
}

export function ephemeralArgs(
  spec: EphemeralContainerSpec,
  detached: boolean,
  holder?: string
): string[] {
  // Its callers pass the shell step's non-secret registry env; a registry token and the
  // container step's `CONTAINER_STEP_INPUT` travel as `secretEnv`, and this refuses a
  // credential if it comes back as a pair.
  assertNoCredentialEnvPairs(spec.env, 'docker ephemeral env');
  const volumeArgs = (spec.volumes ?? []).flatMap((v) => [
    '-v',
    `${v.source}:${v.target}:${v.readOnly ? 'ro' : 'rw'}`,
  ]);
  const flags = [
    ...dockerRuntimeArgs(),
    `--network=${holder ? `container:${holder}` : spec.network === 'egress' ? 'bridge' : 'none'}`,
    ...(!holder ? (spec.dns ?? []).map((d) => `--dns=${d}`) : []),
    `--memory=${spec.memory ?? '512m'}`,
    `--cpus=${spec.cpus ?? 1}`,
    `--pids-limit=${spec.pidsLimit ?? 256}`,
    '--read-only',
    '--tmpfs=/tmp:size=64m,mode=1777',
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    ...(!holder ? (spec.addHosts ?? []).map((h) => `--add-host=${h}`) : []),
    ...(!holder && spec.reachWorker ? [workerHostEntry()] : []),
    ...(spec.env ?? []).flatMap((pair) => ['-e', pair]),
    // Named without a value: docker resolves it from the client's environment.
    ...secretEnvFlags(spec.secretEnv),
    ...volumeArgs,
    ...(spec.workdir ? ['-w', spec.workdir] : []),
  ];
  return [
    'run',
    ...(detached ? ['-d'] : []),
    '--rm',
    ...(spec.name ? ['--name', spec.name] : []),
    ...workspaceLabelArgs(),
    ...flags,
    ...(!holder && spec.publishPort ? ['-p', `127.0.0.1::${spec.publishPort}/tcp`] : []),
    '--',
    spec.image,
    ...(spec.argv ?? []),
  ];
}

export function ephemeralNetworkHolderArgs(
  spec: EphemeralContainerSpec & { name: string },
  holder: string
): string[] {
  const args = ephemeralArgs(
    {
      ...spec,
      argv: ['infinity'],
      env: [],
      image: resolveWorkspaceInfra().metadataBlockImage,
      name: holder,
      secretEnv: undefined,
      volumes: [],
      workdir: undefined,
    },
    true
  );
  args.splice(args.indexOf('--'), 0, '--entrypoint=sleep', '--label', `asw.workspace=${spec.name}`);
  return args;
}

const driver = new DockerWorkspaceBackend();

export function dockerWorkspaceBackend(): DockerWorkspaceBackend {
  return driver;
}
