import { prisma } from '@auto-swe/shared/db';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { workerEgressProxy } from './egressProxy.js';

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

export async function beginWorkspaceEgress(teamId: string | null, bypassHosts: string[] = []) {
  if (!workerEgressProxy()) {
    return null;
  }
  const team = teamId
    ? await prisma.team.findUnique({ select: { egressAllowlist: true }, where: { id: teamId } })
    : null;
  return beginEgressAccess((team?.egressAllowlist as string[] | null) ?? [], bypassHosts);
}
