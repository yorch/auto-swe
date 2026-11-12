import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { type ResolvedGitHubConfig, resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance } from 'fastify';

export async function defaultGitHubInstallation(
  prisma: FastifyInstance['prisma'],
  config: ResolvedGitHubConfig
) {
  const usesApp =
    config.authMode === 'app' ||
    ((config.authMode ?? 'auto') === 'auto' &&
      config.appId &&
      config.appPrivateKey &&
      config.appInstallationId);
  return usesApp && config.appInstallationId
    ? prisma.gitHubInstallation.findUnique({
        where: { host_installationId: { host: '', installationId: config.appInstallationId } },
      })
    : null;
}

export async function installationOrganizationProblem(
  prisma: FastifyInstance['prisma'],
  installationId: string | null | undefined,
  teamId: string,
  repository?: { githubUrl: string | null; githubApiUrl: string | null }
): Promise<boolean> {
  let installation = installationId
    ? await prisma.gitHubInstallation.findUnique({ where: { id: installationId } })
    : null;
  if (!installationId && repository) {
    const config = await resolveGitHubConfig();
    if (
      hostFamily(repository.githubUrl ?? config.baseUrl) === hostFamily(config.baseUrl) &&
      hostFamily(repository.githubApiUrl ?? config.apiUrl) === hostFamily(config.apiUrl)
    ) {
      installation = await defaultGitHubInstallation(prisma, config);
    }
  }
  if (!installation?.organizationId) {
    return false;
  }
  const team = await prisma.team.findUnique({ select: { orgId: true }, where: { id: teamId } });
  return team?.orgId !== installation.organizationId;
}
