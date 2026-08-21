import { prisma } from '@auto-swe/shared/db';
import {
  type RepoDependencyContext,
  type RepoDependencyNeighbor,
  resolveRepoDependencyContext,
} from '@auto-swe/shared/lib/repoDependencyResolver';
import { cloneDependencyRepos, type Workspace } from '../activities/workspace.js';
import { getScmProvider, toRepoRef } from './scm/index.js';

/**
 * Cross-repo context injection (repo dependency graph, P2).
 *
 * The read-side resolver in `@auto-swe/shared/lib/repoDependencyResolver` returns
 * the 1-hop neighbours of a repo across `active` edges only, already filtered to
 * the caller's org. This module turns that structure into the prompt block the
 * review network, the implementer, and (optionally) a full dependency checkout
 * consume.
 *
 * Everything here is **best-effort**: a graph read that fails must never fail a
 * review or an implementation run, so every loader swallows its errors and
 * returns an empty string.
 */

/** Per-direction neighbour cap, so a hub repo cannot blow the prompt budget. */
export const MAX_CROSS_REPO_NEIGHBORS = 8;

/**
 * Per-step opt-ins threaded from the workflow spec (`config.crossRepoContext` /
 * `config.crossRepoCheckout`) down into the activities. Both are optional:
 * `crossRepoContext` defaults ON (a cheap prompt block), `crossRepoCheckout`
 * defaults OFF (it clones repos).
 */
export interface CrossRepoStepOptions {
  /** Clone upstream dependency repos into `/workspace/deps/*` (expensive tier). */
  crossRepoCheckout?: boolean;
  /** Inject the dependency-graph prompt block. Defaults to true when omitted. */
  crossRepoContext?: boolean;
}

/** True unless the step explicitly opted out — the cheap tier is on by default. */
export function wantsCrossRepoContext(options?: CrossRepoStepOptions): boolean {
  return options?.crossRepoContext !== false;
}

/** True only when the step explicitly opted in — the checkout tier costs clones. */
export function wantsCrossRepoCheckout(options?: CrossRepoStepOptions): boolean {
  return options?.crossRepoCheckout === true;
}

/** Longest rendered label. Repo names are unbounded `text` in the DB. */
const MAX_LABEL_CHARS = 80;

/**
 * Flatten a repo-supplied name into one short, inert line.
 *
 * These labels are interpolated into agent SYSTEM prompts, and org/repo names
 * are operator-supplied with no charset or length limit at the API. Left raw, a
 * repo named with newlines and markdown headings can close the context block and
 * append instructions of its own — a prompt-injection payload that reaches the
 * reviewer with the authority of the system message. Collapsing whitespace kills
 * the line breaks the payload needs, and the cap keeps one repo from crowding out
 * the prompt (paid on every TDD iteration and every reviewer).
 */
function sanitizeLabel(raw: string): string {
  const flattened = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length <= MAX_LABEL_CHARS) {
    return flattened;
  }
  return `${flattened.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

/** `org/repo` when both halves are known, else the connection's display name. */
export function repoLabel(repo: RepoDependencyNeighbor['repo']): string {
  const raw =
    repo.organizationName && repo.repoName
      ? `${repo.organizationName}/${repo.repoName}`
      : (repo.repoName ?? repo.name ?? repo.id);
  return sanitizeLabel(raw);
}

/**
 * Highest-confidence neighbours first, then alphabetical — so truncation drops
 * the weakest edges rather than whatever the DB happened to return last, and the
 * rendered block is stable across runs.
 */
function ordered(neighbors: RepoDependencyNeighbor[]): RepoDependencyNeighbor[] {
  return [...neighbors].sort(
    (a, b) => b.confidence - a.confidence || repoLabel(a.repo).localeCompare(repoLabel(b.repo))
  );
}

function renderNeighbors(neighbors: RepoDependencyNeighbor[], noun: string): string[] {
  const sorted = ordered(neighbors);
  const shown = sorted.slice(0, MAX_CROSS_REPO_NEIGHBORS);
  const lines = shown.map((n) => {
    const kinds = n.kinds.length > 0 ? ` — kinds: ${[...n.kinds].sort().join(', ')}` : '';
    return `- ${repoLabel(n.repo)}${kinds}`;
  });
  const hidden = sorted.length - shown.length;
  if (hidden > 0) {
    lines.push(`- …+${hidden} more ${noun} (not shown)`);
  }
  return lines;
}

/**
 * Render the resolved dependency graph into a compact markdown block.
 *
 * Pure — modelled on `formatDesignContext` in `activities/executeImplementation.ts`:
 * returns `''` when there is nothing to show, otherwise a single leading-blank-line
 * `## …` section. Upstream and downstream get deliberately different framing: an
 * upstream repo is a contract to honour, a downstream repo is blast radius.
 */
export function formatRepoDependencyContext(ctx: RepoDependencyContext): string {
  const upstream = ctx.upstream ?? [];
  const downstream = ctx.downstream ?? [];
  if (upstream.length === 0 && downstream.length === 0) {
    return '';
  }

  const sections: string[] = [
    '\n\n## Cross-Repo Dependency Context',
    'This repository participates in a recorded dependency graph. Only confirmed (active)' +
      ' relationships are listed; treat them as facts about the system, not suggestions.',
  ];

  if (upstream.length > 0) {
    sections.push(
      '',
      '### Upstream — contracts this change must honour',
      'This repo depends on the repos below. Their published interfaces, schemas, and' +
        ' behaviours are constraints: do not assume you may change them here, and flag any' +
        ' change that silently diverges from one.',
      ...renderNeighbors(upstream, 'upstream repos')
    );
  }

  if (downstream.length > 0) {
    sections.push(
      '',
      '### Downstream — repos that consume this one',
      'The repos below depend on this one. Assess the breaking-change blast radius of the' +
        ' diff against them: a changed signature, schema, response shape, config key, or' +
        ' removed export is a cross-repo break even when this repo still builds.',
      ...renderNeighbors(downstream, 'downstream repos')
    );
  }

  return sections.join('\n');
}

/**
 * Resolve + format the dependency block for a repo. Never throws.
 *
 * Returns `''` when either identifier is missing (a generic/triggered run may
 * carry no connection, and the resolver is org-scoped by construction) or when
 * the graph read fails — cross-repo context is enrichment, never a gate.
 */
export async function loadRepoDependencyContext(
  repoId: string | null | undefined,
  orgId: string | null | undefined
): Promise<string> {
  if (!repoId || !orgId) {
    return '';
  }
  try {
    const ctx = await resolveRepoDependencyContext(prisma, repoId, { orgId });
    return formatRepoDependencyContext(ctx);
  } catch {
    // Best-effort: a graph failure must never fail a review or an implementation.
    return '';
  }
}

/**
 * Heavyweight `full_checkout` tier: clone this repo's upstream dependencies into
 * `/workspace/deps/<name>` so the agent can read (never write) their real source
 * instead of guessing at their interfaces.
 *
 * Returns a prompt block naming the checked-out paths, or `''` when nothing was
 * cloned. Never throws — the clones are an optimisation, and the run proceeds
 * without them.
 */
export async function checkoutUpstreamRepos(
  workspace: Pick<Workspace, 'exec'>,
  repoId: string | null | undefined,
  orgId: string | null | undefined
): Promise<string> {
  if (!repoId || !orgId) {
    return '';
  }
  try {
    const { upstream } = await resolveRepoDependencyContext(prisma, repoId, { orgId });
    if (upstream.length === 0) {
      return '';
    }

    // Consent gate. Reading a *name* in a prompt is not the same as copying
    // another team's source onto disk where this run's agent can read all of it,
    // so the checkout tier is narrower than the context block: a repo owned by
    // another team is only cloned when a human on both teams agreed to the edge.
    // A `manual` edge is exactly that agreement (the API requires LEAD on both
    // teams to create or confirm one); a detector- or inference-created edge
    // needs no such consent and must not unlock a cross-team checkout.
    const subject = await prisma.connection.findUnique({
      select: { teamId: true },
      where: { id: repoId },
    });
    const consented = upstream.filter(
      (n) => n.repo.teamId === subject?.teamId || n.sources.includes('manual')
    );
    if (consented.length === 0) {
      return '';
    }

    // Re-read the neighbour connections for the clone URL fields the resolver's
    // neighbour projection does not carry (GHE base/api URL, default branch).
    // The `team: { orgId }` predicate is the tenant filter *and* the visibility
    // boundary — kept literal per tenantGuard.coverage.test.ts.
    const neighborIds = ordered(consented)
      .slice(0, MAX_CROSS_REPO_NEIGHBORS)
      .map((n) => n.repo.id);
    const rows = await prisma.connection.findMany({
      select: {
        defaultBranch: true,
        githubApiUrl: true,
        githubUrl: true,
        id: true,
        organizationName: true,
        repoName: true,
      },
      where: {
        id: { in: neighborIds },
        isActive: true,
        team: { orgId },
        type: 'git_repo',
      },
    });
    // Preserve the confidence ordering from the graph, not the DB's row order.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const orderedRows = neighborIds.map((id) => byId.get(id)).filter((r) => r !== undefined);

    const deps: { authedCloneUrl: string; branch?: string; name: string }[] = [];
    for (const row of orderedRows) {
      try {
        const ref = toRepoRef(row);
        const { authedCloneUrl } = await getScmProvider(ref).cloneCredentials(ref);
        deps.push({
          authedCloneUrl,
          branch: row.defaultBranch ?? undefined,
          name: `${row.organizationName}-${row.repoName}`,
        });
      } catch {
        // A dependency we cannot get credentials for is simply not checked out.
      }
    }

    const cloned = await cloneDependencyRepos(workspace, deps);
    if (cloned.length === 0) {
      return '';
    }
    return (
      '\n\n### Upstream sources checked out locally\n' +
      'Read-only shallow clones of the upstream repos are available in this workspace.' +
      ' Read them to confirm an interface instead of assuming it; never edit them —' +
      ' only files under the target repo are part of this change.\n' +
      cloned.map((c) => `- ${c.label} → \`${c.path}\``).join('\n')
    );
  } catch {
    // Best-effort tier — never fail an implementation over a dependency clone.
    return '';
  }
}
