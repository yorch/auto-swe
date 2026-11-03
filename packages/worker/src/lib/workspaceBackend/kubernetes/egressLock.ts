import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { logWarn } from '../../activityLog.js';
import type { CapturedResult } from '../../execUtils.js';
import type { EgressAllowEntry } from '../types.js';
import { MANAGED_BY_LABEL, WORKSPACE_POD_LABEL } from './podSpec.js';

/**
 * The label that moves a pod from the namespace's broad `workspace-egress` policy (which selects
 * `asw/egress NotIn [blocked, restricted]`) to a narrow one: `workspace-egress-blocked` (DNS and
 * the model and registry proxies) or `workspace-egress-restricted` (the same plus the egress
 * forwarding proxy, admitted by selector). NetworkPolicies are additive, so a pod can only be
 * narrowed by ceasing to match the broad policy.
 */
export const EGRESS_LABEL = 'asw/egress';
export const EGRESS_BLOCKED = 'blocked';
export const EGRESS_RESTRICTED = 'restricted';

/** The lock a pod is moved to; the value of the `asw/egress` label. */
export type EgressLockMode = 'blocked' | 'restricted';

/** A destination the per-pod policy admits: one resolved address and, optionally, one port. */
export interface ResolvedAllow {
  ip: string;
  port?: number;
}

/** The name of the per-pod policy that admits the resolved allow entries. */
export function egressPolicyName(podName: string): string {
  return `${podName}-egress`;
}

/** Parses an IPv6 literal into 16 bytes (handles `::` and a dotted IPv4 tail); null if invalid. */
function ipv6Bytes(ip: string): number[] | null {
  let text = ip;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const o = tail.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) {
      return null;
    }
    const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
    text = `${text.slice(0, tail.index)}${hex(o[0] ?? 0, o[1] ?? 0)}:${hex(o[2] ?? 0, o[3] ?? 0)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0] ?? '');
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) {
    return null;
  }
  const all = [...head, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...rest];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) {
      return null;
    }
    const n = Number.parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  return bytes;
}

/** Cloud metadata addresses outside 169.254.0.0/16 (Alibaba, Oracle, Azure wire server). */
const METADATA_V4 = new Set(['100.100.100.200', '192.0.0.192', '168.63.129.16']);

function isForbiddenV4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  return (
    a === 0 || // unspecified / "this network"
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local: AWS/GCP/Azure metadata, ECS task endpoint
    a >= 224 || // multicast, reserved and broadcast
    METADATA_V4.has(octets.join('.'))
  );
}

/**
 * An address a locked-down pod may never be admitted to, whatever name resolved to it: loopback,
 * unspecified, link-local and multicast ranges, and the cloud metadata endpoints (including the
 * AWS IPv6 one, Alibaba's and Oracle's). IPv6 forms that embed an IPv4 address (mapped, compatible,
 * NAT64 and 6to4) are judged by the address they embed. Anything that does not parse is refused.
 * The allow list is written by an operator or a repository's git host, but DNS answers are not theirs.
 */
export function isForbiddenAllowAddress(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0] ?? '';
  const family = isIP(lower);
  if (family === 4) {
    return isForbiddenV4(lower.split('.').map(Number));
  }
  if (family !== 6) {
    return true;
  }
  const b = ipv6Bytes(lower);
  if (!b) {
    return true;
  }
  const embedded = (at: number) => isForbiddenV4(b.slice(at, at + 4));
  const zeroPrefix = (n: number) => b.slice(0, n).every((x) => x === 0);
  const first = ((b[0] ?? 0) << 8) | (b[1] ?? 0);
  return (
    b.every((x) => x === 0) || // ::
    (zeroPrefix(15) && b[15] === 1) || // ::1
    (zeroPrefix(10) && b[10] === 255 && b[11] === 255 && embedded(12)) || // ::ffff:a.b.c.d
    (zeroPrefix(12) && embedded(12)) || // ::a.b.c.d (IPv4-compatible)
    (first === 0x64 &&
      b[2] === 0xff &&
      b[3] === 0x9b &&
      b.slice(4, 12).every((x) => x === 0) &&
      embedded(12)) || // 64:ff9b::/96
    (first === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 1) || // 64:ff9b:1::/48 (local-use NAT64)
    (first === 0x2002 && embedded(2)) || // 6to4
    (first & 0xffc0) === 0xfe80 || // fe80::/10
    b[0] === 0xff || // ff00::/8 multicast
    b.join(',') === '253,0,14,194,0,0,0,0,0,0,0,0,0,0,2,84' // fd00:ec2::254
  );
}

/** Resolves each entry to its addresses; refuses an unresolvable name or a forbidden address. */
export async function resolveAllow(
  allow: EgressAllowEntry[],
  lookup: (host: string) => Promise<string[]> = async (host) =>
    (await dns.lookup(host, { all: true })).map((a) => a.address)
): Promise<ResolvedAllow[]> {
  const out: ResolvedAllow[] = [];
  for (const entry of allow) {
    const addresses = isIP(entry.host) ? [entry.host] : await lookup(entry.host);
    if (addresses.length === 0) {
      throw new Error(`egress allow entry ${entry.host} resolved to no address`);
    }
    for (const ip of addresses) {
      if (isForbiddenAllowAddress(ip)) {
        throw new Error(`egress allow entry ${entry.host} resolves to a refused address (${ip})`);
      }
      out.push({ ip, ...(entry.port === undefined ? {} : { port: entry.port }) });
    }
  }
  return out;
}

/**
 * The per-pod NetworkPolicy that adds the resolved allow entries to what the shared
 * `workspace-egress-blocked` / `workspace-egress-restricted` policy already admits (DNS and the
 * worker's proxies). It selects the pod by its name label *and* the mode label, and is owned by
 * the pod, so it is garbage collected with it. It names Egress only: ingress is already denied by
 * the shared policy.
 *
 * Every entry becomes an `ipBlock`. The egress proxy under `restricted` is admitted by the shared
 * policy's selector, not by address, so a caller that also passes it here (a Service ClusterIP)
 * gets a harmless extra rule: NetworkPolicy semantics for traffic addressed to a Service IP are
 * undefined and most CNIs match the post-DNAT pod IP, so that rule may simply never match. It is
 * neither relied on nor detected.
 */
export function buildEgressAllowPolicy(
  podName: string,
  podUid: string,
  namespace: string,
  allow: ResolvedAllow[],
  mode: EgressLockMode = EGRESS_BLOCKED
): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      labels: { [MANAGED_BY_LABEL]: 'auto-swe', [WORKSPACE_POD_LABEL]: podName },
      name: egressPolicyName(podName),
      namespace,
      ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: podName, uid: podUid }],
    },
    spec: {
      egress: allow.map((a) => ({
        ...(a.port === undefined ? {} : { ports: [{ port: a.port, protocol: 'TCP' }] }),
        to: [{ ipBlock: { cidr: `${a.ip}/${isIP(a.ip) === 6 ? 128 : 32}` } }],
      })),
      podSelector: {
        matchLabels: { [EGRESS_LABEL]: mode, [WORKSPACE_POD_LABEL]: podName },
      },
      policyTypes: ['Egress'],
    },
  };
}

/** `kubectl label` argv that selects the pod for the blocked or restricted policies. */
export function labelBlockedArgs(
  namespace: string,
  podName: string,
  mode: EgressLockMode = EGRESS_BLOCKED
): string[] {
  return [
    'label',
    'pod',
    podName,
    '--namespace',
    namespace,
    '--overwrite',
    `${EGRESS_LABEL}=${mode}`,
    `${WORKSPACE_POD_LABEL}=${podName}`,
  ];
}

/** `kubectl get` argv that prints only the pod's uid, for the policy's owner reference. */
export function podUidArgs(namespace: string, podName: string): string[] {
  return ['get', 'pod', podName, '--namespace', namespace, '-o', 'jsonpath={.metadata.uid}'];
}

/** A TCP destination probed from inside the pod. */
interface ProbeTarget {
  host: string;
  port: number;
}

/**
 * Public addresses tried, in order, until one accepts a connection from the unlocked pod. Only a
 * target that was reachable before the label can show, by becoming unreachable after it, that the
 * label did something: an address a firewall or an IPv6-only network already drops proves nothing.
 */
const PUBLIC_PROBES: ProbeTarget[] = [
  { host: '1.1.1.1', port: 80 },
  { host: '1.1.1.1', port: 443 },
  { host: '8.8.8.8', port: 443 },
  { host: '9.9.9.9', port: 443 },
];

/** What one TCP probe saw. `unknown` is a probe that produced no verdict (exec failed). */
type ProbeState = 'open' | 'closed' | 'notool' | 'error' | 'unknown';

/**
 * A TCP-level connect check with whichever of `nc`, `bash` (/dev/tcp, under `timeout`) and `curl`
 * the image has, never following a redirect and never needing an HTTP status. It prints a final
 * `asw_probe=<state>` line: `open` (the connection was accepted), `closed` (timeout, refused or
 * unreachable) or `error`/`notool` (the tool itself failed or none exists — not a verdict).
 */
export function probeScript(target: ProbeTarget): string {
  const { host, port } = target;
  return [
    `H=${host}; P=${port}`,
    'try_nc() { command -v nc >/dev/null 2>&1 || return 3; o=$(nc -z -w3 "$H" "$P" 2>&1); r=$?; ' +
      '[ $r -eq 0 ] && return 0; ' +
      'case "$o" in *sage*|*nvalid*|*nrecognized*|*llegal*|*ot?found*) return 3;; esac; return 1; }',
    'try_bash() { command -v bash >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 || return 3; ' +
      'o=$(timeout 4 bash -c "exec 3<>/dev/tcp/$H/$P" 2>&1); r=$?; [ $r -eq 0 ] && return 0; ' +
      'case "$r" in 124|137|143) return 1;; esac; ' +
      'case "$o" in *"No such file"*|*"not supported"*|*"not found"*) return 3;; esac; return 1; }',
    // --noproxy '*' and the cleared proxy variables test the direct path, not a path through the
    // egress proxy that a restricted workspace is allowed to use. Exit 7 (Failed to connect) and
    // 28 (Timeout was reached) mean the direct connection did not open; 2-6 and 127 are the tool
    // failing (usage, init, URL, proxy/host resolution, missing binary), which is no verdict.
    'try_curl() { command -v curl >/dev/null 2>&1 || return 3; ' +
      'o=$(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY curl -sS --noproxy \'*\' --connect-timeout 3 --max-time 4 -o /dev/null "http://$H:$P/" 2>&1); r=$?; ' +
      'case "$r" in 7|28) return 1;; 2|3|4|5|6|127) return 3;; esac; return 0; }',
    'for t in try_nc try_bash try_curl; do $t; r=$?; ' +
      'if [ $r -ne 3 ]; then [ $r -eq 0 ] && echo asw_probe=open || echo asw_probe=closed; exit 0; fi; done',
    'echo asw_probe=notool',
  ].join('\n');
}

function probeState(result: CapturedResult): ProbeState {
  const m = /asw_probe=(open|closed|notool|error)/.exec(result.stdout);
  return (m?.[1] as ProbeState | undefined) ?? 'unknown';
}

export interface EgressLockDeps {
  /** Runs `kubectl` with the manifest (if any) on stdin; never throws on a non-zero exit. */
  kubectl: (args: string[], stdin?: string) => Promise<CapturedResult>;
  /** Runs a shell command in the pod. */
  probe: (script: string) => Promise<CapturedResult>;
  namespace: string;
  lookup?: (host: string) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  /** How long the CNI may take to apply the label change before the lock is called ineffective. */
  verifyAttempts?: number;
  pollIntervalMs?: number;
}

/**
 * Finds a public destination the not-yet-locked pod can open a TCP connection to. Without one the
 * lock cannot be proven, so it throws rather than let "unreachable" pass for "blocked".
 */
async function pickReachableTarget(
  podName: string,
  deps: EgressLockDeps,
  resolved: ResolvedAllow[]
): Promise<ProbeTarget> {
  const seen: string[] = [];
  for (const target of PUBLIC_PROBES) {
    // An address the pod is allowed to reach stays reachable after the lock, so it never closes.
    if (resolved.some((r) => r.ip === target.host)) {
      seen.push(`${target.host}:${target.port}=allowed`);
      continue;
    }
    const state = probeState(await deps.probe(probeScript(target)));
    if (state === 'open') {
      return target;
    }
    if (state === 'notool' || state === 'error') {
      throw new Error(
        `workspace ${podName}: cannot verify the egress lock — the image has no working TCP probe ` +
          '(nc, bash with timeout, or curl)'
      );
    }
    seen.push(`${target.host}:${target.port}=${state}`);
  }
  throw new Error(
    `workspace ${podName}: cannot verify the egress lock — no public probe address was reachable ` +
      `before locking (${seen.join(', ')}), so an unreachable address afterwards would prove ` +
      'nothing. Allow outbound access to one of them for the unlocked pod, or run this policy on ' +
      'a cluster whose workspaces can reach the public internet.'
  );
}

/**
 * Cuts one pod off the network, and fails unless it provably is. A public address is first shown
 * to be reachable from the unlocked pod; then the per-pod allow policy (inert until the label
 * matches), then the label that swaps the broad policy for the narrow ones, then a poll until
 * that same address is unreachable. Anything short of that throws, and the caller removes the pod.
 */
export async function lockPodEgress(
  podName: string,
  allow: EgressAllowEntry[],
  deps: EgressLockDeps,
  mode: EgressLockMode = EGRESS_BLOCKED
): Promise<void> {
  const resolved = await resolveAllow(allow, deps.lookup);
  const target = await pickReachableTarget(podName, deps, resolved);
  if (resolved.length > 0) {
    const got = await deps.kubectl(podUidArgs(deps.namespace, podName));
    const uid = got.stdout.trim();
    if (got.exitCode !== 0 || !/^[0-9a-f-]{36}$/i.test(uid)) {
      throw new Error(`workspace ${podName}: could not read the pod's uid: ${got.stderr}`);
    }
    const policy = buildEgressAllowPolicy(podName, uid, deps.namespace, resolved, mode);
    const created = await deps.kubectl(
      ['create', '--namespace', deps.namespace, '-f', '-'],
      JSON.stringify(policy)
    );
    if (created.exitCode !== 0) {
      throw new Error(
        `workspace ${podName}: could not create its egress policy: ${created.stderr}`
      );
    }
  }
  const labelled = await deps.kubectl(labelBlockedArgs(deps.namespace, podName, mode));
  if (labelled.exitCode !== 0) {
    throw new Error(`workspace ${podName}: could not label the pod as ${mode}: ${labelled.stderr}`);
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = deps.verifyAttempts ?? 15;
  let last: ProbeState = 'unknown';
  // Two consecutive `closed` samples: one dropped connection could be the target blinking, not
  // the policy taking effect.
  let closedInARow = 0;
  for (let i = 0; i < attempts; i++) {
    const result = await deps.probe(probeScript(target));
    last = probeState(result);
    closedInARow = last === 'closed' ? closedInARow + 1 : 0;
    if (closedInARow >= 2) {
      await warnIfAllowedUnreachable(podName, resolved, deps);
      return;
    }
    if (last === 'notool' || last === 'error') {
      break;
    }
    await sleep(deps.pollIntervalMs ?? 2000);
  }
  throw new Error(
    `workspace ${podName}: egress is not blocked — the pod could reach ${target.host}:${target.port} ` +
      `before locking and the check afterwards says "${last}". Apply the current ` +
      'infra/kubernetes/workspace-namespace.yaml (the workspace-egress-blocked and ' +
      'workspace-egress-restricted policies and the asw/egress selector on workspace-egress) and ' +
      'use a CNI that enforces NetworkPolicy.'
  );
}

/** An allowed address that is down is not a hole in the lock, so it warns rather than throws. */
async function warnIfAllowedUnreachable(
  podName: string,
  resolved: ResolvedAllow[],
  deps: EgressLockDeps
): Promise<void> {
  const first = resolved.find((r) => r.port !== undefined && isIP(r.ip) === 4);
  if (!first || first.port === undefined) {
    return;
  }
  try {
    const result = await deps.probe(probeScript({ host: first.ip, port: first.port }));
    if (probeState(result) === 'closed') {
      logWarn('a locked workspace could not reach its allowed destination', {
        pod: podName,
        target: `${first.ip}:${first.port}`,
      });
    }
  } catch {
    /* advisory */
  }
}
