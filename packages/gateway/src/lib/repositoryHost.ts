/**
 * Matching an incoming GitHub payload to a repository by host as well as name.
 *
 * A repository's identity is (host, owner, name), owner and name compared
 * case-insensitively: `acme/api` on github.com and
 * on a GitHub Enterprise server are different repositories. A webhook names a
 * repository by `full_name`, which carries no host, so on its own it would
 * match both. The payload's `repository.html_url` does carry it.
 *
 * A connection's host is its web base override (`githubUrl`, stored as an
 * origin), or the instance's own host when that is null.
 */
import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { originOf } from '@auto-swe/shared/lib/connectionCredential';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

/**
 * The `Connection` predicate selecting repositories on the host `htmlUrl`
 * lives on.
 *
 * An absent or unparseable URL returns no constraint — the name-only match the
 * webhook made before repositories had a host. The instance's own host also
 * matches a row whose override spells that same host.
 */
export async function repositoryHostWhere(
  htmlUrl: string | undefined
): Promise<Prisma.ConnectionWhereInput> {
  const origin = htmlUrl ? originOf(htmlUrl) : null;
  if (!origin) {
    return {};
  }
  const instanceOrigin = originOf((await resolveGitHubConfig()).baseUrl);
  if (origin === instanceOrigin) {
    return { OR: [{ githubUrl: null }, { githubUrl: origin }] };
  }
  return { githubUrl: origin };
}

/** `host[:port]` of a URL, lowercased, or null when it does not parse. */
function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether the repository a delivery names is on the host its secret proved.
 *
 * A per-host secret proves the delivery came from that host, so a payload it
 * signs may only describe repositories there. With no verified host (the
 * instance secret) there is nothing to compare, and an absent `html_url`
 * constrains nothing — the connection scope below still applies. A URL that
 * does not parse cannot be shown to be on the host, so it does not match.
 */
export function deliveryHostMatches(
  verifiedHost: string | null,
  htmlUrl: string | undefined
): boolean {
  if (verifiedHost === null || !htmlUrl) {
    return true;
  }
  return hostOfUrl(htmlUrl) === verifiedHost;
}

/**
 * The `Connection` predicate binding a delivery to the host its secret proves.
 *
 * A connection's host is its web base override (`githubUrl`), or the instance's
 * own host when that is null.
 *
 * - A per-host secret (`verifiedHost`) reaches only connections on that host.
 * - The instance secret (`verifiedHost` null) reaches none on a host that has
 *   a webhook secret of its own: those hosts are verified with it alone.
 */
export async function webhookHostScope(
  prisma: PrismaClient,
  verifiedHost: string | null
): Promise<Prisma.ConnectionWhereInput> {
  let ownSecretHosts: Set<string> | null = null;
  if (verifiedHost === null) {
    const rows = await prisma.gitHubHostWebhookSecret.findMany({ select: { host: true } });
    if (rows.length === 0) {
      return {};
    }
    ownSecretHosts = new Set(rows.map((r) => r.host.toLowerCase()));
  }
  const instanceHost = hostOfUrl((await resolveGitHubConfig()).baseUrl);
  const connections = await runUnscoped(
    'a webhook names a GitHub repository, not a team',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: { githubUrl: true, id: true },
        where: { type: 'git_repo' },
      })
  );
  const hostOf = (c: { githubUrl: string | null }) =>
    c.githubUrl === null ? instanceHost : hostOfUrl(c.githubUrl);
  if (verifiedHost !== null) {
    return { id: { in: connections.filter((c) => hostOf(c) === verifiedHost).map((c) => c.id) } };
  }
  const excluded = connections
    .filter((c) => {
      const host = hostOf(c);
      return host !== null && ownSecretHosts?.has(host);
    })
    .map((c) => c.id);
  return { id: { notIn: excluded } };
}

/**
 * `value` as a literal for a case-insensitive `equals`.
 *
 * Prisma compiles `{ equals, mode: 'insensitive' }` to `ILIKE` without
 * escaping, so `_` and `%` in a repository name are wildcards: `MY_REPO` would
 * match `my-repo`. A backslash is the pattern's escape character, so these three
 * are escaped.
 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Owner or repository name, compared case-insensitively and literally. GitHub
 * treats both as case-insensitive, and a payload's casing need not match what
 * was stored at onboarding.
 */
export function insensitiveName(value: string): { equals: string; mode: 'insensitive' } {
  return { equals: likeLiteral(value), mode: 'insensitive' };
}

/**
 * The `Connection` predicate a webhook naming `org/repo` should match.
 *
 * The delivery is always bound to the host its secret proved
 * (`webhookHostScope`). Beyond that, the payload's host is consulted only when
 * the name alone is ambiguous: the same owner/name (compared case-insensitively)
 * onboarded on more than one distinct host. A deployment reaching one host
 * matches by name exactly as it always did, so a configured web URL that spells
 * the host differently from what GitHub puts in `html_url` (an internal name, a
 * proxy) cannot make its webhooks stop matching.
 */
export async function webhookRepositoryWhere(
  prisma: PrismaClient,
  org: string,
  repoName: string,
  htmlUrl: string | undefined,
  verifiedHost: string | null
): Promise<Prisma.ConnectionWhereInput> {
  const hostScope = await webhookHostScope(prisma, verifiedHost);
  // GitHub owner and repository names are case-insensitive, and a payload's
  // casing need not match what was stored at onboarding.
  const byName: Prisma.ConnectionWhereInput = {
    organizationName: insensitiveName(org),
    repoName: insensitiveName(repoName),
    ...hostScope,
  };
  // The verified host already decides it; `html_url` is attacker-supplied.
  if (verifiedHost !== null || !htmlUrl) {
    return byName;
  }
  const candidates = await runUnscoped(
    'a webhook names a GitHub repository, not a team',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: { githubUrl: true },
        where: { ...byName, type: 'git_repo' },
      })
  );
  // Rows on one host (legacy case-only duplicates among them) are not a host
  // ambiguity: filtering on a host would only risk matching none of them.
  const instanceHost = hostOfUrl((await resolveGitHubConfig()).baseUrl);
  const hosts = new Set(
    candidates.map((c) => (c.githubUrl === null ? instanceHost : hostOfUrl(c.githubUrl)))
  );
  if (hosts.size < 2) {
    return byName;
  }
  return { ...byName, ...(await repositoryHostWhere(htmlUrl)) };
}
