import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import type { EgressPolicy } from '@auto-swe/shared/lib/egressPolicy';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { currentRequestContext } from './config/contextLookup.js';
import { workerEgressProxy } from './egressProxy.js';
import type { EgressAllowEntry } from './workspaceBackend/types.js';

const HOSTNAME = /^[a-z0-9][a-z0-9.-]*$/;
/** A bracketed IPv6 or IPv4 literal, as `URL.hostname` spells one. */
const BRACKETED_IP = /^\[[0-9a-f:.]+\]$/;

/** Only a plain hostname or an IP literal may reach `NO_PROXY`: no `*`, comma, space or userinfo. */
function validHost(host: string | undefined): string | null {
  const lowered = host?.toLowerCase();
  return lowered && (HOSTNAME.test(lowered) || BRACKETED_IP.test(lowered)) ? lowered : null;
}

/**
 * Hostname of a repository URL (an `https://…`, `ssh://…` or `git@host:path` form), or null when
 * there is none or it is not a plain hostname or IP literal.
 */
export function gitHostOf(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  let parsed: string | null = null;
  try {
    parsed = validHost(new URL(url).hostname);
  } catch {
    // Not a URL at all.
  }
  if (parsed) {
    return parsed;
  }
  // `git@host:path` (or `user:pw@host:path`) parses as a URL with no host. A URL that failed to
  // parse (`https://a b.com`) is not an scp form: no `//` after the colon.
  return validHost(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/.exec(url)?.[1]);
}

/**
 * `bypassHosts` are reached directly and never through the proxy: the repository's own git host
 * must keep working for clone, fetch and push regardless of the team allowlist, exactly as it did
 * before the proxy existed (and a GitHub Enterprise host is routinely a private address, which
 * the proxy's private-address guard would refuse).
 */
export async function beginEgressAccess(allowlist: string[], bypassHosts: string[] = []) {
  const proxy = workerEgressProxy();
  if (!proxy) {
    return null;
  }
  const registration = await proxy.register(allowlist);
  const url = new URL(registration.url);
  url.username = 'egress';
  url.password = registration.token;
  const infra = resolveWorkspaceInfra();
  const noProxy = [
    'localhost',
    '127.0.0.1',
    '::1',
    ...[infra.registryProxy, infra.harnessModelProxy].flatMap((config) =>
      config ? [new URL(config.url).hostname] : []
    ),
    ...bypassHosts,
  ].join(',');
  return {
    env: [`NO_PROXY=${noProxy}`, `no_proxy=${noProxy}`],
    registration,
    secretEnv: {
      HTTP_PROXY: url.href,
      HTTPS_PROXY: url.href,
      http_proxy: url.href,
      https_proxy: url.href,
    },
  };
}

/** The code on every failure that means "this egress policy cannot be enforced here". */
export const EGRESS_POLICY_UNENFORCEABLE = 'EGRESS_POLICY_UNENFORCEABLE';

/**
 * A refusal that retrying cannot fix (a missing proxy, a failed lock): non-retryable, so the
 * activity fails once and says why instead of burning its retry budget.
 */
export function egressPolicyFailure(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, EGRESS_POLICY_UNENFORCEABLE);
}

/**
 * `policy` is the run's egress policy. `open` keeps the proxy's reading of an empty allowlist
 * (any public host). `restricted` makes the allowlist mandatory: a non-empty one needs the
 * proxy (and refuses to run without it, since nothing else enforces it); an empty one reaches
 * nothing, so it needs no proxy and returns null — the caller locks the network exactly as for
 * `blocked`. `blocked` is enforced by the network (`lockEgress`), not here.
 *
 * Under `restricted` the proxy is only cooperative (`HTTP_PROXY`); the caller must also lock the
 * workspace to the proxy's address so it cannot be bypassed.
 */
export async function beginWorkspaceEgress(
  teamId: string | null,
  bypassHosts: string[] = [],
  policy: EgressPolicy = 'open'
) {
  if (policy === 'blocked') {
    return null;
  }
  if (policy === 'open' && !workerEgressProxy()) {
    return null;
  }
  const team = teamId
    ? await prisma.team.findUnique({ select: { egressAllowlist: true }, where: { id: teamId } })
    : null;
  const allowlist = (team?.egressAllowlist as string[] | null) ?? [];
  if (policy === 'restricted') {
    if (allowlist.length === 0) {
      return null;
    }
    if (!workerEgressProxy()) {
      throw egressPolicyFailure(
        "egress policy 'restricted' cannot be enforced: the worker's egress proxy is not configured"
      );
    }
  }
  return beginEgressAccess(allowlist, bypassHosts);
}

/**
 * A shell or container step that will run with `network: 'egress'` under `restricted` is held to
 * the team allowlist by the egress proxy alone. Without the proxy it would run with only the
 * network's DNS filter, so refuse instead. A no-op under any other policy or network.
 *
 * Limitation: this is cooperative enforcement only. A step runs on a bridge network with
 * `HTTP_PROXY`, DNS filtering and `--add-host` pins, and is NOT network-locked the way a
 * `restricted` workspace is (`lockEgress`), so a raw socket or `--noproxy` bypasses the proxy. The
 * step's audit record says so (`egress (proxy-enforced only; not network-locked)`).
 */
export function assertStepEgressEnforceable(
  policy: EgressPolicy,
  stepNetwork: 'none' | 'egress'
): void {
  if (policy === 'restricted' && stepNetwork === 'egress' && !workerEgressProxy()) {
    throw egressPolicyFailure(
      "egress policy 'restricted' cannot be enforced for this step: the worker's egress proxy is not configured"
    );
  }
}

/**
 * The run's egress policy: the pinned `workspace.egressPolicy` of the run the current activity
 * belongs to (`currentRequestContext` carries the run's pinned settings), at the team's scope.
 *
 * With no pin and no run context (outside an activity, or a workflow with no run row, such as an
 * eval) it resolves live. The organization is derived from the team so an ORGANIZATION override
 * still applies; a WORKFLOW_TEMPLATE override cannot be reached without a run, so in that case it
 * is not seen.
 */
export async function resolveRunEgressPolicy(teamId: string | null): Promise<EgressPolicy> {
  const ctx = await currentRequestContext();
  let orgId = ctx.orgId;
  if (orgId === undefined && teamId) {
    const team = await prisma.team.findUnique({ select: { orgId: true }, where: { id: teamId } });
    orgId = team?.orgId ?? undefined;
  }
  return resolveSetting('workspace.egressPolicy', {
    ...ctx,
    ...(orgId ? { orgId } : {}),
    ...(teamId ? { teamId } : {}),
  });
}

/**
 * What a shell or container step's `network` becomes under `policy`. `blocked` forces `none`;
 * `restricted` with an empty team allowlist forces `none` (the proxy would deny everything
 * anyway, and `none` says so up front). `capped` is true only when the step asked for `egress`
 * and did not get it.
 */
export function capStepNetwork(
  policy: EgressPolicy,
  teamAllowlist: readonly string[],
  requested: 'none' | 'egress' | undefined
): { network: 'none' | 'egress'; capped: boolean } {
  const network = requested ?? 'none';
  const forced = policy === 'blocked' || (policy === 'restricted' && teamAllowlist.length === 0);
  return forced && network === 'egress'
    ? { capped: true, network: 'none' }
    : { capped: false, network };
}

/** The git host's default port for each clone-URL scheme. */
const SCHEME_PORTS: Record<string, number> = {
  'git+ssh:': 22,
  'http:': 80,
  'https:': 443,
  'ssh:': 22,
};

/** The ports a clone URL reaches its host on: the scheme's default, or the one it names. */
function gitPorts(cleanUrl: string | undefined): number[] {
  try {
    const url = new URL(cleanUrl ?? '');
    const port = Number(url.port) || SCHEME_PORTS[url.protocol];
    if (port) {
      return [port];
    }
  } catch {
    // Not a URL: the scp form (`git@host:path`) is ssh.
  }
  return cleanUrl ? [22] : [443, 22];
}

/**
 * The destinations a locked-down workspace keeps: the worker's model and registry proxies (only
 * when configured / wired), and the repository's git host on the port its clone URL uses — the
 * scheme's default (80 http, 443 https, 22 ssh and scp forms) or the explicit one — so clone,
 * fetch and push still work. With no clone URL, 443 and 22.
 *
 * `egressProxyUrl` is added only for `restricted` with a team allowlist: the workspace may then
 * reach the worker's egress proxy, and nothing else outward, so `HTTP_PROXY` cannot be bypassed.
 * `blocked` omits it: nothing the proxy could forward to is reachable.
 */
export function blockedEgressAllow(
  gitHost: string | null,
  options: { cleanUrl?: string; egressProxyUrl?: string; registryUrl?: string | null } = {}
): EgressAllowEntry[] {
  const infra = resolveWorkspaceInfra();
  const entries: EgressAllowEntry[] = [];
  for (const raw of [infra.harnessModelProxy?.url, options.registryUrl, options.egressProxyUrl]) {
    if (!raw) {
      continue;
    }
    const url = new URL(raw);
    entries.push({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    });
  }
  if (gitHost) {
    for (const port of gitPorts(options.cleanUrl)) {
      entries.push({ host: gitHost.replace(/^\[|\]$/g, ''), port });
    }
  }
  return entries;
}
