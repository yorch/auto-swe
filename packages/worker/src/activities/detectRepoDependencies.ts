import { prisma } from '@auto-swe/shared/db';
import {
  MANIFEST_FILES,
  parseCodeowners,
  parseGitmodules,
  parseManifest,
} from '@auto-swe/shared/lib/manifestParsers';
import {
  matchRepoDependency,
  type RepoDependencyCandidate,
} from '@auto-swe/shared/lib/repoDependencyMatch';
import { findEdgeWriteTarget } from '../lib/repoDependencyEdgeWrite.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import type { RepoRef, ScmProvider } from '../lib/scm/types.js';

export interface DetectRepoDependenciesInput {
  repoId: string;
}

export interface DetectRepoDependenciesResult {
  /** Resolved edges created or refreshed (source `manifest` | `git_signal`). */
  edgesUpserted: number;
  /** File paths that were actually found and parsed in this repo. */
  scanned: string[];
  /** Unresolved suggestions created or refreshed (`toRepoId: null`). */
  suggestions: number;
}

/**
 * CODEOWNERS locations to try, in GitHub's own precedence order. Only the
 * first one found is used — GitHub itself only honors a single location.
 */
const CODEOWNERS_PATHS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

const EDGE_KIND = 'code';

interface RawDependency {
  manifestPath: string;
  raw: string;
  source: 'manifest' | 'git_signal';
}

/**
 * Fetch a file for the detector, tolerating any fetch failure — a missing
 * manifest is the normal case, and a transient/auth error on one file must
 * not sink the whole scan. Logged (not silently dropped) so a real, recurring
 * failure is still visible in worker logs.
 */
async function safeFetchFile(
  provider: ScmProvider,
  repoRef: RepoRef,
  path: string
): Promise<string | null> {
  try {
    return await provider.fetchFileContent(repoRef, path);
  } catch (err) {
    console.error(
      `detectRepoDependencies: failed to fetch ${path} from ${repoRef.organizationName}/${repoRef.repoName}`,
      err
    );
    return null;
  }
}

/**
 * Create-or-refresh a `RepoDependency` row on its natural key. Prisma can't
 * `upsert` a partial-unique-index model, so this is `findFirst` +
 * conditional `create`/`update`. Returns `false` (not counted) when the
 * existing row is `dismissed` — the depended-upon team's veto is sticky and
 * a re-run must never resurrect it — so re-running the detector is safe to
 * call repeatedly and idempotent either way.
 */
async function upsertEdge(
  where: {
    fromRepoId: string;
    kind: string;
    source: string;
    toRef: string | null;
    toRepoId: string | null;
  },
  data: { detail: Record<string, unknown>; status: 'active' | 'unresolved' }
): Promise<boolean> {
  const target = await findEdgeWriteTarget(where);
  if (target.kind === 'vetoed') {
    return false;
  }
  if (target.kind === 'existing') {
    await prisma.repoDependency.update({
      data: { detail: data.detail as never },
      where: { id: target.id },
    });
    return true;
  }

  await prisma.repoDependency.create({
    data: {
      confidence: 1,
      detail: data.detail as never,
      fromRepoId: where.fromRepoId,
      kind: where.kind,
      source: where.source,
      status: data.status,
      toRef: where.toRef,
      toRepoId: where.toRepoId,
    },
  });
  return true;
}

/**
 * Detect this repo's dependencies from its manifests (`source: 'manifest'`)
 * and git signals — `.gitmodules` + `CODEOWNERS` (`source: 'git_signal'`) —
 * and write/refresh the corresponding `RepoDependency` edges.
 *
 * A raw dependency string that resolves against an onboarded, same-tenant
 * repo becomes a resolved `active` edge; anything else becomes an
 * `unresolved` suggestion (`toRepoId: null`, `toRef: <raw>`) surfaced for
 * onboarding. Not an LLM activity — no `AgentTracer`; errors from the
 * candidate lookup or the writes propagate so Temporal retries the activity.
 * Individual manifest-file fetch failures are caught inside
 * {@link safeFetchFile} instead, since a missing file is the expected case.
 */
export async function detectRepoDependencies(
  input: DetectRepoDependenciesInput
): Promise<DetectRepoDependenciesResult> {
  const empty: DetectRepoDependenciesResult = { edgesUpserted: 0, scanned: [], suggestions: 0 };

  const connection = await prisma.connection.findUnique({
    select: {
      githubApiUrl: true,
      githubUrl: true,
      id: true,
      installation: { select: { installationId: true } },
      isActive: true,
      organizationName: true,
      repoName: true,
      team: { select: { orgId: true } },
      type: true,
    },
    where: { id: input.repoId },
  });

  // Skip gracefully: not found, not a git repo, deactivated, or missing the
  // git identity a non-git-repo row could otherwise have (defensive).
  if (
    connection?.type !== 'git_repo' ||
    !connection.isActive ||
    !connection.organizationName ||
    !connection.repoName
  ) {
    return empty;
  }

  const repoRef = toRepoRef(connection);
  const provider = getScmProvider(repoRef);

  const scanned: string[] = [];
  const rawDeps: RawDependency[] = [];

  for (const manifestPath of MANIFEST_FILES) {
    const content = await safeFetchFile(provider, repoRef, manifestPath);
    if (content === null) {
      continue;
    }
    scanned.push(manifestPath);
    for (const raw of parseManifest(manifestPath, content)) {
      rawDeps.push({ manifestPath, raw, source: 'manifest' });
    }
  }

  const gitmodulesContent = await safeFetchFile(provider, repoRef, '.gitmodules');
  if (gitmodulesContent !== null) {
    scanned.push('.gitmodules');
    for (const raw of parseGitmodules(gitmodulesContent)) {
      rawDeps.push({ manifestPath: '.gitmodules', raw, source: 'git_signal' });
    }
  }

  for (const codeownersPath of CODEOWNERS_PATHS) {
    const content = await safeFetchFile(provider, repoRef, codeownersPath);
    if (content === null) {
      continue;
    }
    scanned.push(codeownersPath);
    for (const raw of parseCodeowners(content)) {
      rawDeps.push({ manifestPath: codeownersPath, raw, source: 'git_signal' });
    }
    break; // only one CODEOWNERS location is honored, first found wins
  }

  if (rawDeps.length === 0) {
    return { ...empty, scanned };
  }

  // Candidate repos this raw dependency string can resolve to: active
  // git_repo connections in the same tenant org. Literal `team: { orgId }`
  // predicate required by tenantGuard.coverage.test.ts — do not extract into
  // a helper or spread it in.
  const candidateRows = await prisma.connection.findMany({
    select: { id: true, organizationName: true, packageNames: true, repoName: true },
    where: { isActive: true, team: { orgId: connection.team.orgId }, type: 'git_repo' },
  });
  const candidates: RepoDependencyCandidate[] = candidateRows.map((c) => ({
    id: c.id,
    organizationName: c.organizationName,
    packageNames: c.packageNames,
    repoName: c.repoName,
  }));

  let edgesUpserted = 0;
  let suggestions = 0;
  // Dedupe within this run: the same raw string can legitimately appear more
  // than once (e.g. both dependencies and devDependencies), and would
  // otherwise race itself on the natural-key findFirst+create above.
  const seen = new Set<string>();

  for (const dep of rawDeps) {
    const matchedRepoId = matchRepoDependency(dep.raw, candidates);
    if (matchedRepoId === connection.id) {
      continue; // self-edge — a repo never depends on itself
    }

    const dedupeKey = `${dep.source}:${matchedRepoId ?? `ref:${dep.raw}`}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    const detail = { manifestPath: dep.manifestPath, raw: dep.raw };
    // A raw ref that resolves now may have been recorded as an unresolved
    // suggestion on an earlier sweep, before its repo was onboarded. That row is
    // keyed on `toRef` and the resolved edge is keyed on `toRepoId`, so writing
    // the edge alone would strand the suggestion in the onboarding list forever.
    // Close it out here, and carry a dismissal forward: a team that rejected the
    // suggestion has already answered for the edge it becomes.
    const staleSuggestion = matchedRepoId
      ? await prisma.repoDependency.findFirst({
          where: {
            fromRepoId: connection.id,
            kind: EDGE_KIND,
            source: dep.source,
            toRef: dep.raw,
            toRepoId: null,
          },
        })
      : null;
    if (staleSuggestion?.status === 'dismissed') {
      continue;
    }

    const upserted = matchedRepoId
      ? await upsertEdge(
          {
            fromRepoId: connection.id,
            kind: EDGE_KIND,
            source: dep.source,
            toRef: null,
            toRepoId: matchedRepoId,
          },
          { detail, status: 'active' }
        )
      : await upsertEdge(
          {
            fromRepoId: connection.id,
            kind: EDGE_KIND,
            source: dep.source,
            toRef: dep.raw,
            toRepoId: null,
          },
          { detail, status: 'unresolved' }
        );

    if (staleSuggestion) {
      // The resolved edge now carries this dependency; drop the superseded
      // suggestion so it stops showing as "waiting to be onboarded".
      await prisma.repoDependency.delete({ where: { id: staleSuggestion.id } });
    }

    if (upserted) {
      if (matchedRepoId) {
        edgesUpserted++;
      } else {
        suggestions++;
      }
    }
  }

  return { edgesUpserted, scanned, suggestions };
}
