/**
 * One-shot checks that a stored connection works: a GitHub credential set, a GitHub App
 * installation, a package registry, and a repository's access.
 *
 * Every check answers with fixed wording. A remote server controls its own error text, and a
 * fetch error can name the internal address that was tried, so neither is passed through; only
 * a status class, a login or a slug that GitHub itself reports is shown. A secret never appears
 * in a result. Requests go through the guarded fetch (a self-hosted host on a private address
 * is allowed where the operator approved it, loopback and metadata addresses never are) and
 * follow no redirect: the guard approved one URL, not wherever it points.
 *
 * A check never throws. A caller gets a `ProbeResult` whatever happens, because a probe that
 * can abort its caller is a button that sometimes shows nothing.
 */
import type { PrismaClient } from '@auto-swe/shared';
import {
  CredentialUnreadableError,
  repositoryHostsAllowed,
  resolveUserCredential,
} from '@auto-swe/shared/lib/connectionCredential';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  resolveHostCredential,
  resolvePlatformCredential,
} from '@auto-swe/shared/lib/githubHostCredential';
import {
  defaultApiUrlForHost,
  hostFamily,
  installationTargetFor,
  isGitHubRepository,
} from '@auto-swe/shared/lib/githubHostScope';
import {
  createGitHubAppJwt,
  fetchGitHubAppIdentity,
  GitHubTokenMissingError,
  PlatformCredentialHostError,
  resolveGitHubToken,
} from '@auto-swe/shared/lib/githubInstallation';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';
import type { PermissionRepo } from '@auto-swe/shared/lib/repoPermission';
import { checkProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import {
  type ResolvedGitHubConfig,
  resolveGitHubApproverAppConfig,
  resolveGitHubConfig,
} from '@auto-swe/shared/lib/systemConfig';

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProbeResult {
  ok: boolean;
  /** One sentence for a page to show: the first failure, else every check's detail. */
  detail: string;
  checks: ProbeCheck[];
  durationMs: number;
}

const TIMEOUT_MS = 10_000;
const UNREACHABLE = 'The host could not be reached.';

const pass = (name: string, detail: string): ProbeCheck => ({ detail, name, ok: true });
const fail = (name: string, detail: string): ProbeCheck => ({ detail, name, ok: false });

/** Fixed wording per status class: the remote body is never echoed back. */
function refusal(status: number): string {
  if (status === 401) {
    return 'the credential was rejected';
  }
  if (status === 403) {
    return 'the credential is not permitted or is rate limited';
  }
  if (status === 404) {
    return 'it was not found, or the credential cannot see it';
  }
  if (status >= 500) {
    return 'the server reported an error';
  }
  return 'the request was refused';
}

export function summarize(checks: ProbeCheck[], startedAt: number): ProbeResult {
  const failed = checks.find((c) => !c.ok);
  return {
    checks,
    detail: failed ? failed.detail : checks.map((c) => c.detail).join(' '),
    durationMs: Date.now() - startedAt,
    ok: failed === undefined,
  };
}

/** A result for a check that could not start, so the caller still gets the one shape. */
export function failed(name: string, detail: string): ProbeResult {
  return { checks: [fail(name, detail)], detail, durationMs: 0, ok: false };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** `status` 0 means no answer was obtained. */
interface Reply {
  status: number;
  body: unknown;
}

function githubFetchFor(apiUrl: string): typeof fetch {
  return createGuardedFetch({ allowPrivate: hostFamily(apiUrl) !== 'github.com' });
}

async function githubGet(
  doFetch: typeof fetch,
  apiUrl: string,
  path: string,
  bearer: string
): Promise<Reply> {
  try {
    const res = await doFetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${bearer}`,
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { body, status: res.status };
  } catch {
    return { body: null, status: 0 };
  }
}

const refused = (what: string, reply: Reply): string =>
  reply.status === 0 ? UNREACHABLE : `${what} returned ${reply.status}: ${refusal(reply.status)}.`;

/** The credentials one GitHub host holds: a PAT, a GitHub App, or both. */
export interface GitHubCredentialSet {
  token: string | null;
  appId: string | null;
  appPrivateKey: string | null;
}

/**
 * Check a credential set against its host: the PAT authenticates, and the App's id and key
 * belong together and are installed somewhere. An App with no installation is reported as a
 * failure because nothing it could do would reach a repository.
 */
export async function probeGitHubCredentialSet(
  set: GitHubCredentialSet,
  apiUrl: string,
  fetchImpl: typeof fetch = githubFetchFor(apiUrl)
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const checks: ProbeCheck[] = [];
  if (!(set.token || set.appId)) {
    return failed('Credential', 'No token or GitHub App is set.');
  }
  if (set.token) {
    const reply = await githubGet(fetchImpl, apiUrl, '/user', set.token);
    const login = asRecord(reply.body).login;
    checks.push(
      reply.status === 200 && typeof login === 'string'
        ? pass('Token', `Token authenticates as ${login}.`)
        : fail('Token', refused('GitHub', reply))
    );
  }
  if (set.appId && set.appPrivateKey) {
    checks.push(await probeApp(set.appId, set.appPrivateKey, apiUrl, fetchImpl));
  } else if (set.appId) {
    checks.push(fail('App', 'The GitHub App has no private key.'));
  }
  return summarize(checks, startedAt);
}

async function probeApp(
  appId: string,
  privateKey: string,
  apiUrl: string,
  fetchImpl: typeof fetch
): Promise<ProbeCheck> {
  const identity = await fetchGitHubAppIdentity({ apiUrl, appId, fetchImpl, privateKey });
  if (!identity.ok) {
    return fail(
      'App',
      identity.reason === 'rejected' ? 'GitHub rejected the App id and private key.' : UNREACHABLE
    );
  }
  let jwt: string;
  try {
    jwt = createGitHubAppJwt(appId, privateKey);
  } catch {
    return fail('App', 'GitHub rejected the App id and private key.');
  }
  const reply = await githubGet(fetchImpl, apiUrl, '/app/installations?per_page=100', jwt);
  if (reply.status !== 200 || !Array.isArray(reply.body)) {
    // The identity already proved the key; only the install count is missing.
    return pass('App', `App ${identity.slug} is valid.`);
  }
  const count = reply.body.length;
  if (count === 0) {
    return fail('App', `App ${identity.slug} is valid but is not installed on any account.`);
  }
  return pass(
    'App',
    `App ${identity.slug} is valid and installed on ${count === 100 ? '100 or more' : count} account${count === 1 ? '' : 's'}.`
  );
}

/**
 * Check the instance's GitHub App end to end: the id and key belong together, GitHub issues an
 * installation token for the configured installation, and that token lists repositories. This is
 * the check a saved App configuration never had; without it a wrong installation id passes the
 * form and fails the first run.
 */
export async function probeAppInstallation(
  config: ResolvedGitHubConfig,
  installationId: string,
  apiUrl: string,
  fetchImpl: typeof fetch = githubFetchFor(apiUrl)
): Promise<ProbeResult> {
  const startedAt = Date.now();
  if (!(config.appId && config.appPrivateKey)) {
    return failed('App', 'The GitHub App has no private key.');
  }
  const checks: ProbeCheck[] = [];
  const identity = await fetchGitHubAppIdentity({
    apiUrl,
    appId: config.appId,
    fetchImpl,
    privateKey: config.appPrivateKey,
  });
  if (!identity.ok) {
    checks.push(
      fail(
        'App',
        identity.reason === 'rejected' ? 'GitHub rejected the App id and private key.' : UNREACHABLE
      )
    );
    return summarize(checks, startedAt);
  }
  checks.push(pass('App', `App ${identity.slug} is valid.`));

  let token: string;
  try {
    token = await resolveGitHubToken({ ...config, authMode: 'app' }, { apiUrl, installationId });
  } catch (err) {
    checks.push(
      fail(
        'Installation token',
        err instanceof PlatformCredentialHostError
          ? 'The credential does not belong to this GitHub host.'
          : `GitHub would not issue a token for installation ${installationId}: check the installation id and that the App is installed.`
      )
    );
    return summarize(checks, startedAt);
  }
  const reply = await githubGet(fetchImpl, apiUrl, '/installation/repositories?per_page=1', token);
  const total = asRecord(reply.body).total_count;
  checks.push(
    reply.status === 200 && typeof total === 'number'
      ? pass(
          'Installation',
          `Installation ${installationId} can reach ${total} repositor${total === 1 ? 'y' : 'ies'}.`
        )
      : fail('Installation', refused('GitHub', reply))
  );
  return summarize(checks, startedAt);
}

/** What a registry check needs from a stored row, decrypted by the caller. */
export interface RegistryProbeInput {
  ecosystem: string;
  upstreamUrl: string;
  authKind: string;
  allowPrivateNetwork: boolean;
  /** Plaintext token; never stored, logged or returned. */
  token: string | null;
}

/** Where each ecosystem answers a cheap request. npm has a ping; the others are asked at their root. */
function registryProbePath(ecosystem: string): string {
  return ecosystem === 'npm' ? '/-/ping' : '/';
}

/**
 * Check a package registry's upstream: reachable, and (when a token is stored) not rejecting it.
 * A registry that answers 404 on the probe path was reached but has no cheap endpoint to prove
 * the credential against, and the result says so rather than claiming the token was verified.
 */
export async function probePackageRegistry(
  input: RegistryProbeInput,
  fetchImpl?: typeof fetch
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const safety = checkProbeUrl(input.upstreamUrl, { allowPrivate: input.allowPrivateNetwork });
  if (!safety.ok) {
    return failed('Registry', 'The saved upstream URL is not allowed.');
  }
  const doFetch = fetchImpl ?? createGuardedFetch({ allowPrivate: input.allowPrivateNetwork });
  const headers: Record<string, string> = { 'User-Agent': 'auto-swe/1.0' };
  if (input.token) {
    // The same spelling the registry proxy sends upstream.
    headers.Authorization =
      input.authKind === 'basic'
        ? `Basic ${Buffer.from(input.token).toString('base64')}`
        : `Bearer ${input.token}`;
  }
  let status: number;
  try {
    const res = await doFetch(
      `${input.upstreamUrl.replace(/\/$/, '')}${registryProbePath(input.ecosystem)}`,
      { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    await res.body?.cancel().catch(() => undefined);
    status = res.status;
  } catch {
    return failed('Registry', UNREACHABLE);
  }
  if (status >= 200 && status < 300) {
    return summarize(
      [
        pass(
          'Registry',
          input.token
            ? 'The registry answered and accepted the credential.'
            : 'The registry answered.'
        ),
      ],
      startedAt
    );
  }
  if (status === 401 || status === 403) {
    return summarize(
      [
        fail(
          'Registry',
          input.token
            ? `The registry returned ${status}: the credential was rejected or is not permitted.`
            : `The registry returned ${status} and no token is stored, so it needs one.`
        ),
      ],
      startedAt
    );
  }
  if (status === 404 || (status >= 300 && status < 400)) {
    return summarize(
      [
        pass(
          'Registry',
          `The registry was reached (HTTP ${status} on the probe path); it has no endpoint that confirms the credential.`
        ),
      ],
      startedAt
    );
  }
  return summarize(
    [fail('Registry', `The registry returned ${status}: ${refusal(status)}.`)],
    startedAt
  );
}

/** The `Connection` columns a repository check reads. */
export type RepositoryProbeTarget = PermissionRepo & { id: string; defaultBranch: string };

type RepoCredentialLabel = 'Platform credential' | 'Your saved token';

async function repositoryChecks(
  label: RepoCredentialLabel,
  apiUrl: string,
  repo: { organizationName: string; repoName: string; defaultBranch: string },
  token: string
): Promise<ProbeCheck[]> {
  const doFetch = githubFetchFor(apiUrl);
  const slug = `${encodeURIComponent(repo.organizationName)}/${encodeURIComponent(repo.repoName)}`;
  const reply = await githubGet(doFetch, apiUrl, `/repos/${slug}`, token);
  if (reply.status !== 200) {
    return [fail(`${label}: repository`, refused('GitHub', reply))];
  }
  const permissions = asRecord(asRecord(reply.body).permissions);
  // A credential type that reports no permissions (an installation token) gives no level to judge.
  const hasLevel = 'push' in permissions || 'pull' in permissions;
  const checks: ProbeCheck[] = [];
  if (!hasLevel) {
    checks.push(
      pass(
        `${label}: repository`,
        `${label} can see ${repo.organizationName}/${repo.repoName}; this credential does not report a permission level.`
      )
    );
  } else if (permissions.push === true || permissions.admin === true) {
    checks.push(
      pass(
        `${label}: repository`,
        `${label} can push to ${repo.organizationName}/${repo.repoName}.`
      )
    );
  } else {
    checks.push(
      fail(
        `${label}: repository`,
        `${label} can read ${repo.organizationName}/${repo.repoName} but not push, so runs cannot open pull requests.`
      )
    );
  }
  const branch = await githubGet(
    doFetch,
    apiUrl,
    `/repos/${slug}/branches/${encodeURIComponent(repo.defaultBranch)}`,
    token
  );
  checks.push(
    branch.status === 200
      ? pass(`${label}: default branch`, `Default branch ${repo.defaultBranch} exists.`)
      : fail(
          `${label}: default branch`,
          branch.status === 404
            ? `Default branch ${repo.defaultBranch} was not found on GitHub; check the branch name on the repository.`
            : refused('GitHub', branch)
        )
  );
  return checks;
}

/**
 * Check what a run on `repo` would be able to do: the platform credential for the repository's
 * host mints a token, sees the repository and may push, and the default branch exists. A caller
 * who saved their own token for the repository gets the same checks with it, because that token
 * is the identity their runs act as.
 */
export async function probeRepositoryAccess(
  prisma: PrismaClient,
  repo: RepositoryProbeTarget,
  userId: string
): Promise<ProbeResult> {
  const startedAt = Date.now();
  if (!(repo.organizationName && repo.repoName)) {
    return failed('Repository', 'This connection has no GitHub repository to check.');
  }
  // Both credentials below are GitHub credentials: another provider's repository is never probed
  // with them, whatever its URLs say.
  if (!isGitHubRepository(repo)) {
    return failed(
      'Repository',
      `This repository is served by "${repo.scmProvider}", which this check does not support; no GitHub credential is used for it.`
    );
  }
  const target = {
    defaultBranch: repo.defaultBranch,
    organizationName: repo.organizationName,
    repoName: repo.repoName,
  };
  const hosts = await repositoryHostsAllowed({
    githubApiUrl: repo.githubApiUrl,
    githubUrl: repo.githubUrl,
  });
  if (!hosts.ok) {
    return failed('Host', "The repository's GitHub URL is not on an approved host.");
  }

  const checks: ProbeCheck[] = [];
  checks.push(...(await platformChecks(repo, target)));

  let own: Awaited<ReturnType<typeof resolveUserCredential>> | 'unreadable' | 'error';
  try {
    own = await resolveUserCredential(prisma, { connectionId: repo.id, userId });
  } catch (err) {
    own = err instanceof CredentialUnreadableError ? 'unreadable' : 'error';
  }
  if (own === 'unreadable') {
    checks.push(
      fail('Your saved token', 'Your saved token can no longer be decrypted. Save it again.')
    );
  } else if (own === 'error') {
    checks.push(fail('Your saved token', 'Your saved token could not be read right now.'));
  } else if (own) {
    checks.push(...(await repositoryChecks('Your saved token', own.apiUrl, target, own.token)));
  }
  return summarize(checks, startedAt);
}

async function platformChecks(
  repo: RepositoryProbeTarget,
  target: { defaultBranch: string; organizationName: string; repoName: string }
): Promise<ProbeCheck[]> {
  const name = 'Platform credential';
  const ghConfig = await resolveGitHubConfig();
  const scoped = {
    apiUrl: repo.githubApiUrl,
    baseUrl: repo.githubUrl,
    installationHost: repo.installation?.host ?? null,
    installationId: repo.installation?.installationId ?? null,
    organizationName: target.organizationName,
    repoName: target.repoName,
    scmProvider: repo.scmProvider,
  };
  let credential: Awaited<ReturnType<typeof resolvePlatformCredential>>;
  try {
    credential = await resolvePlatformCredential(scoped, ghConfig);
  } catch {
    return [fail(name, "The host's stored credentials could not be read.")];
  }
  if (credential.scope === 'scm-provider') {
    return [fail(name, `No GitHub credential applies to a "${credential.provider}" repository.`)];
  }
  if (credential.scope === 'mismatch') {
    return [
      fail(
        name,
        `No platform credential is configured for ${credential.host}. Add one under GitHub host credentials.`
      ),
    ];
  }
  if (credential.scope === 'misconfigured') {
    return [
      fail(
        name,
        "The repository's web and API URLs are on different hosts, so no credential is attached."
      ),
    ];
  }
  if (credential.scope === 'installation-mismatch') {
    return [fail(name, `The repository's installation belongs to a different host.`)];
  }
  const installTarget = installationTargetFor(scoped, credential.config);
  let token: string;
  try {
    token = await resolveGitHubToken(credential.config, installTarget);
  } catch (err) {
    if (err instanceof GitHubTokenMissingError) {
      return [fail(name, 'No platform token or GitHub App installation is configured.')];
    }
    if (err instanceof PlatformCredentialHostError) {
      return [fail(name, 'The credential does not belong to this GitHub host.')];
    }
    return [
      fail(name, 'GitHub would not issue a token: check the App id, private key and installation.'),
    ];
  }
  return repositoryChecks('Platform credential', installTarget.apiUrl, target, token);
}

/** One host's stored credentials (a row of `GitHubHostCredential`), decrypted for the check only. */
export async function probeHostCredential(host: string): Promise<ProbeResult> {
  let credential: Awaited<ReturnType<typeof resolveHostCredential>>;
  try {
    credential = await resolveHostCredential(host);
  } catch {
    return failed('Credential', 'A stored secret could not be read. Enter it again and save.');
  }
  if (!credential) {
    return failed(
      'Credential',
      'The host has no usable token or GitHub App, or is no longer an approved host.'
    );
  }
  return probeGitHubCredentialSet(credential, defaultApiUrlForHost(host));
}

/**
 * The approver App: GitHub is asked who the stored key's App is, and the answer must be the App
 * id and slug on file. A wrong slug leaves every approval unrecognisable, and the save-time check
 * cannot see a key revoked since.
 */
export async function probeApproverApp(): Promise<ProbeResult> {
  const name = 'Approver App';
  let config: Awaited<ReturnType<typeof resolveGitHubApproverAppConfig>>;
  try {
    config = await resolveGitHubApproverAppConfig();
  } catch {
    return failed(name, 'The stored private key could not be read. Enter it again.');
  }
  if (!config) {
    return failed(name, 'The approver App is not fully configured.');
  }
  const startedAt = Date.now();
  const identity = await fetchGitHubAppIdentity({
    apiUrl: (await resolveGitHubConfig()).apiUrl,
    appId: config.appId,
    privateKey: config.privateKey,
  });
  if (!identity.ok) {
    return failed(
      name,
      identity.reason === 'rejected'
        ? 'GitHub rejected the approver App id and private key.'
        : UNREACHABLE
    );
  }
  const matches =
    identity.id === config.appId && identity.slug.toLowerCase() === config.appSlug.toLowerCase();
  return summarize(
    [
      matches
        ? pass(name, `Approver App ${identity.slug} is valid.`)
        : fail(
            name,
            `GitHub says this key belongs to ${identity.slug}, not the configured slug; approvals would not be recognised.`
          ),
    ],
    startedAt
  );
}

/** The columns of a `PackageRegistry` row a check reads. */
export interface RegistryRow {
  ecosystem: string;
  upstreamUrl: string;
  authKind: string;
  allowPrivateNetwork: boolean;
  tokenCiphertext: Uint8Array | null;
  tokenNonce: Uint8Array | null;
  tokenAuthTag: Uint8Array | null;
  tokenKeyVersion: number | null;
}

/** A stored registry: its token is decrypted here, sent to the registry's own URL, never returned. */
export async function probeRegistryRow(row: RegistryRow): Promise<ProbeResult> {
  let token: string | null = null;
  if (row.tokenCiphertext && row.tokenNonce && row.tokenAuthTag && row.tokenKeyVersion !== null) {
    try {
      token = decryptSecret({
        authTag: row.tokenAuthTag,
        ciphertext: row.tokenCiphertext,
        keyVersion: row.tokenKeyVersion,
        nonce: row.tokenNonce,
      });
    } catch {
      return failed('Registry', 'The stored token could not be read. Enter it again and save.');
    }
  }
  return probePackageRegistry({
    allowPrivateNetwork: row.allowPrivateNetwork,
    authKind: row.authKind,
    ecosystem: row.ecosystem,
    token,
    upstreamUrl: row.upstreamUrl,
  });
}
