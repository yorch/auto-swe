import { Resolver } from 'node:dns/promises';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { logWarn } from './activityLog.js';

/** Any address record proves the resolver answers; the name only has to be widely resolvable. */
const DNS_PROBE_HOST = 'github.com';

/** Long enough for a slow-but-working resolver, short enough not to delay a boot by much. */
const DNS_PROBE_TIMEOUT_MS = 2_500;

/** A resolver under test: resolves a name against one configured server, or rejects. */
export type DnsProbe = (server: string) => Promise<unknown>;

async function probeResolver(server: string): Promise<unknown> {
  const resolver = new Resolver({ timeout: DNS_PROBE_TIMEOUT_MS, tries: 1 });
  resolver.setServers([server]);
  return resolver.resolve4(DNS_PROBE_HOST);
}

/**
 * Warn when none of the configured workspace resolvers answers from here.
 *
 * Every workspace container is started with exactly `WORKSPACE_DNS`, so a
 * resolver this network blocks looks healthy on the host (which uses its own
 * resolver) and fails only inside a workspace: the egress-lock sidecar inherits
 * the workspace's DNS and dies in `apk add`, and every clone/install fails with
 * a temporary-error message that does not mention DNS at all. The line that
 * does explain it — the baseline host skipped for resolving to no address — is
 * a warning among many.
 *
 * This deliberately complements the egress-capability probe (`probeEgressCapability`,
 * added in #701): that one proves whether the lock can be *applied* and reports
 * a generic detail when it cannot, while this one names the DNS cause behind a
 * failure it would otherwise only hint at.
 *
 * Advisory only, and never throws: a diagnostic that refused to start a worker
 * whose containers might be fine would be worse than the symptom it explains.
 */
export async function warnIfWorkspaceDnsUnreachable(
  probe: DnsProbe = probeResolver
): Promise<void> {
  try {
    const infra = resolveWorkspaceInfra();
    // Kubernetes hands the pod its resolvers through the cluster's DNS config;
    // WORKSPACE_DNS does not reach those containers, so a failure here says
    // nothing about them.
    if (infra.backend === 'kubernetes' || infra.dns.length === 0) {
      return;
    }
    const answers = await Promise.all(
      infra.dns.map(async (server) => {
        try {
          await probe(server);
          return true;
        } catch {
          return false;
        }
      })
    );
    if (answers.some(Boolean)) {
      return;
    }
    logWarn(
      `No workspace DNS resolver answered a probe for ${DNS_PROBE_HOST}: ${infra.dns.join(', ')}. ` +
        'Every workspace container is started with exactly these resolvers, so the egress-lock ' +
        "sidecar's `apk add` and every clone or install inside a workspace will fail with a DNS " +
        "error. Set WORKSPACE_DNS to a resolver containers can reach — the host's own resolver " +
        'or its upstream — then restart the worker.',
      { resolvers: infra.dns }
    );
  } catch {
    // A broken probe is not evidence that the resolvers are unreachable, and
    // this is a diagnostic: say nothing rather than stop the boot.
  }
}
