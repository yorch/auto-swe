import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { createGitHubAppJwt } from '@auto-swe/shared/lib/githubInstallation';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';
import type { ResolvedGitHubConfig } from '@auto-swe/shared/lib/systemConfig';

export async function verifyGithubInstaller(
  config: ResolvedGitHubConfig,
  code: string,
  installationId: string
): Promise<string | null> {
  const fetcher = createGuardedFetch({ allowPrivate: hostFamily(config.apiUrl) !== 'github.com' });
  const exchange = await fetcher(`${config.baseUrl.replace(/\/$/, '')}/login/oauth/access_token`, {
    body: JSON.stringify({
      client_id: config.appClientId,
      client_secret: config.appClientSecret,
      code,
    }),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!exchange.ok) {
    throw new Error('GitHub authorization could not be completed');
  }
  const tokenBody = (await exchange.json()) as { access_token?: unknown };
  if (typeof tokenBody.access_token !== 'string' || !tokenBody.access_token) {
    throw new Error('GitHub authorization could not be completed');
  }
  const api = config.apiUrl.replace(/\/$/, '');
  let found = false;
  for (let page = 1; page <= 100; page++) {
    const response = await fetcher(`${api}/user/installations?per_page=100&page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${tokenBody.access_token}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error('GitHub installations could not be verified');
    }
    const body = (await response.json()) as { installations?: { id: number }[] };
    if (!Array.isArray(body.installations)) {
      throw new Error('GitHub installations could not be verified');
    }
    if (body.installations.some((i) => String(i.id) === installationId)) {
      found = true;
      break;
    }
    if (body.installations.length < 100) {
      break;
    }
  }
  if (!found) {
    return null;
  }
  const response = await fetcher(`${api}/app/installations/${installationId}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${createGitHubAppJwt(config.appId as string, config.appPrivateKey as string)}`,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error('GitHub installation could not be verified');
  }
  const body = (await response.json()) as {
    id?: number;
    account?: { login?: string };
    suspended_at?: string | null;
  };
  if (String(body.id) !== installationId || !body.account?.login || body.suspended_at) {
    return null;
  }
  return body.account.login;
}
