import { prisma } from '@auto-swe/shared/db';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { workerEgressProxy } from './egressProxy.js';

export async function beginEgressAccess(allowlist: string[]) {
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

export async function beginWorkspaceEgress(teamId: string | null) {
  if (!workerEgressProxy()) {
    return null;
  }
  const team = teamId
    ? await prisma.team.findUnique({ select: { egressAllowlist: true }, where: { id: teamId } })
    : null;
  return beginEgressAccess((team?.egressAllowlist as string[] | null) ?? []);
}
