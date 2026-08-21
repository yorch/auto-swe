/**
 * Pure resolution of a raw dependency string (from a manifest, `.gitmodules`,
 * or `CODEOWNERS`) against a set of candidate git_repo Connections. No I/O —
 * the caller loads candidates (already scoped to the right org/tenant) and
 * calls `matchRepoDependency` once per raw string.
 *
 * Precedence, most to least confident — the first tier that produces a match
 * wins, and later tiers are never consulted once an earlier one hits:
 *
 *   1. **Exact `packageNames` entry** (case-insensitive). The repo's own
 *      declared publish name(s) — explicit opt-in data on the Connection row,
 *      so it beats every inferred shape.
 *   2. **`org/repo` shape**, including every git URL spelling that reduces to
 *      the same pair: `acme/payments-api`, `github.com/acme/payments-api`,
 *      `https://github.com/acme/payments-api(.git)`,
 *      `git@github.com:acme/payments-api.git`, and the npm scoped-package
 *      shape `@acme/payments-sdk` (the scope doubles as an org-shape signal).
 *      All forms normalize to the same `{org, repo}` pair and are matched
 *      against `organizationName`/`repoName` together.
 *   3. **Bare repo-name equality** — the weakest signal, since short repo
 *      names collide across orgs. Only used when exactly one candidate's
 *      `repoName` matches; an ambiguous bare-name match (zero or multiple
 *      hits) resolves to `null` rather than guessing.
 */

export interface RepoDependencyCandidate {
  id: string;
  organizationName: string | null;
  repoName: string | null;
  packageNames: string[];
}

/** Normalized org/repo pair extracted from a raw dependency string, if any shape matched. */
function extractOrgRepo(raw: string): { org: string; repo: string } | null {
  const s = raw.trim();

  // scp-like syntax: git@host:org/repo(.git)
  let m = s.match(/^git@[^:/]+:([^/\s]+)\/([^/\s]+?)(\.git)?\/?$/i);
  if (m) {
    return { org: m[1], repo: m[2] };
  }

  // scheme://host/org/repo(.git)
  m = s.match(/^(?:https?|ssh|git):\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+?)(\.git)?\/?$/i);
  if (m) {
    return { org: m[1], repo: m[2] };
  }

  // bare host/org/repo, e.g. github.com/acme/payments-api(.git)
  m = s.match(/^[\w.-]+\.[a-z]{2,}\/([^/\s]+)\/([^/\s]+?)(\.git)?\/?$/i);
  if (m) {
    return { org: m[1], repo: m[2] };
  }

  // npm scoped package: @scope/name
  m = s.match(/^@([\w.-]+)\/([\w.-]+)$/);
  if (m) {
    return { org: m[1], repo: m[2] };
  }

  // bare org/repo (exactly one slash; reject a first segment that looks like
  // a hostname so "github.com/x" without a third segment doesn't misparse)
  m = s.match(/^([\w-]+)\/([\w.-]+?)(\.git)?\/?$/);
  if (m) {
    return { org: m[1], repo: m[2] };
  }

  return null;
}

/**
 * Resolve `raw` against `candidates`. Returns the matching candidate's `id`,
 * or `null` if nothing matches at any precedence tier.
 */
export function matchRepoDependency(
  raw: string,
  candidates: RepoDependencyCandidate[]
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();

  // 1. Exact packageNames entry.
  const byPackageName = candidates.find((c) =>
    c.packageNames.some((p) => p.toLowerCase() === lower)
  );
  if (byPackageName) {
    return byPackageName.id;
  }

  const parsed = extractOrgRepo(trimmed);

  // 2. org/repo shape (bare, URL, or scoped-package form).
  if (parsed) {
    const org = parsed.org.toLowerCase();
    const repo = parsed.repo.toLowerCase().replace(/\.git$/, '');
    const byOrgRepo = candidates.find(
      (c) => c.organizationName?.toLowerCase() === org && c.repoName?.toLowerCase() === repo
    );
    if (byOrgRepo) {
      return byOrgRepo.id;
    }
  }

  // 3. Bare repo-name equality — weakest tier, only when unambiguous.
  const bareName = (parsed?.repo ?? trimmed).toLowerCase().replace(/\.git$/, '');
  const byName = candidates.filter((c) => c.repoName?.toLowerCase() === bareName);
  if (byName.length === 1) {
    return byName[0].id;
  }

  return null;
}
