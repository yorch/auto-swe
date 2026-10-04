import { isTerminalActiveWorkflowStatus } from '../types/api.js';

/**
 * Generate the base Temporal workflow ID for a ticket in one repository:
 * `eng-<org>-<repo>-<ticket>`.
 *
 * Owner and repository name are lowercased: they are case-insensitive
 * identities, so a repository's id does not depend on the casing it was stored
 * with. Two legacy rows for one repository under different casings produce the
 * same string, which is why the allocator treats rows of one repository as one
 * ({@link chooseWorkflowId}'s `owner.sameRepoIds`). The ticket id keeps its
 * casing: it is an external key the tracker owns (and the branch name is built
 * from it), and lowercasing it would rename the id of every run already in
 * flight. {@link legacyWorkflowIdBases} lists the cased ids earlier runs may hold.
 *
 * The ID must be unique across all workflows to avoid collisions.
 * Including organizationName prevents collisions between repos with
 * the same name in different organizations.
 *
 * A repository on a host other than the instance's own — its `githubUrl`
 * override — also carries that host, because `acme/api` on github.com and on a
 * GitHub Enterprise server are different repositories and must not share
 * workflow ids. A repository on the instance host has no override and keeps
 * exactly the id it always had, so nothing already running changes.
 *
 * The format is kept for continuity — running workflows are looked up by it —
 * but it is **not unique on its own**: every part may contain hyphens, so
 * `acme` / `payments-api` / `X-1` and `acme-payments` / `api` / `X-1` produce
 * the same string. {@link chooseWorkflowId} resolves that by checking which
 * repository an existing row belongs to, so a collision across tenants gets a
 * disambiguated ID instead of a spurious "already running" conflict.
 */
export function generateWorkflowId(
  externalTicketId: string,
  organizationName: string,
  repoName: string,
  githubUrl?: string | null
): string {
  return buildWorkflowId(
    externalTicketId,
    organizationName.toLowerCase(),
    repoName.toLowerCase(),
    githubUrl
  );
}

function buildWorkflowId(
  externalTicketId: string,
  organizationName: string,
  repoName: string,
  githubUrl?: string | null
): string {
  const host = githubUrl ? hostSegment(githubUrl) : null;
  return host
    ? `eng-${host}-${organizationName}-${repoName}-${externalTicketId}`
    : `eng-${organizationName}-${repoName}-${externalTicketId}`;
}

/**
 * The ids the same ticket may still be running under from before the current
 * format: owner and name as stored (before they were lowercased), with and
 * without the host segment (before repository ids carried their host). An
 * execution of the same repository still in flight under any of them blocks a
 * duplicate start, so the allocator checks them as well as the current id. The
 * current id itself is never among them, and the result has no duplicates.
 */
export function legacyWorkflowIdBases(
  externalTicketId: string,
  organizationName: string,
  repoName: string,
  githubUrl?: string | null
): string[] {
  const current = generateWorkflowId(externalTicketId, organizationName, repoName, githubUrl);
  const candidates = [
    buildWorkflowId(externalTicketId, organizationName, repoName, githubUrl),
    buildWorkflowId(externalTicketId, organizationName, repoName),
  ];
  return [...new Set(candidates)].filter((id) => id !== current);
}

function hostSegment(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Generate a branch name for a work request. The prefix is the resolved
 * `branchPrefix` from `resolveWorkflowDefaults()` — callers pass it in so the
 * DB-configured value (with its own env fallback) is the only source.
 */
export function generateBranchName(externalTicketId: string, branchPrefix: string): string {
  return `${branchPrefix}/${externalTicketId}`;
}

/**
 * The alternate base used when {@link generateWorkflowId}'s string is already
 * held by a DIFFERENT repository's workflow: the base plus the first eight hex
 * digits of this repository's id. Deterministic, so every later submission for
 * the same ticket+repo lands in the same family.
 */
export function disambiguatedWorkflowIdBase(baseId: string, repoId: string): string {
  return `${baseId}-x${repoId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

/** One existing `ActiveWorkflow` row whose ID may belong to this ticket's family. */
export interface WorkflowIdCandidate {
  temporalWorkflowId: string;
  currentStatus: string;
  /** Owning repository; null on rows that predate the column (treated as ours). */
  repoId: string | null;
  /** The work request's ticket, when the row links one (null = unknown, treated as ours). */
  externalTicketId?: string | null;
}

export type WorkflowIdAllocation =
  | { workflowId: string; isRerun: boolean }
  | { conflictWorkflowId: string };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The IDs in one base's family: the base itself and its `-r<N>` reruns. */
function familyRe(base: string): RegExp {
  return new RegExp(`^${escapeRe(base)}(-r\\d+)?$`);
}

/**
 * Prefixes whose rows {@link chooseWorkflowId} needs to see, for building the
 * `startsWith` / equality query. Pass `repoId` when known, and `legacyBaseId`
 * for ids from an earlier format (see {@link legacyWorkflowIdBases}).
 */
export function workflowIdFamilyBases(
  baseId: string,
  repoId?: string | readonly string[] | null,
  legacyBaseIds: readonly string[] = []
): string[] {
  // Every repository id that is the same repository gets its disambiguated
  // family read too: a run started under one of them still blocks the others.
  const repoIds = repoId ? [repoId].flat() : [];
  const bases = [baseId, ...repoIds.map((r) => disambiguatedWorkflowIdBase(baseId, r))];
  const legacy = legacyBaseIds.filter((l) => l !== baseId);
  return [
    ...bases,
    ...legacy,
    ...repoIds.flatMap((r) => legacy.map((l) => disambiguatedWorkflowIdBase(l, r))),
  ];
}

/** Who is starting the ticket: the repository, and which other rows are the same repository. */
export interface WorkflowIdOwner {
  repoId: string;
  externalTicketId?: string;
  /**
   * Every repository id with the same identity as `repoId` (same host, owner and
   * name compared case-insensitively), `repoId` included or not. A row of any of
   * them is ours: it blocks a duplicate start and counts as a previous run of
   * this ticket. Omitted, only `repoId` itself is.
   */
  sameRepoIds?: readonly string[];
}

/**
 * Decide the workflow ID for a new submission from the existing rows in its
 * family (see {@link workflowIdFamilyBases}).
 *
 * - A non-terminal row that is ours → conflict (the ticket is still running).
 * - Rows owned by a different repository or ticket are never a conflict: they
 *   only share our ID *string*. Rows of another repository id with the same
 *   identity (`owner.sameRepoIds`) are the same repository, not a different one. If one sits in the base family we move to the
 *   {@link disambiguatedWorkflowIdBase} family.
 * - Otherwise the first unused ID in the chosen family: the base, then `-r1`,
 *   `-r2`, … — `isRerun` when we have run this ticket before.
 *
 * `legacyBaseIds` are the ids the same ticket may hold from before the current
 * format (see {@link legacyWorkflowIdBases}: stored casing, no host segment). An
 * execution of OUR repository still in flight under one of them, or under its
 * disambiguated family, blocks a second one exactly as one under `baseId`
 * does — otherwise the upgrade, or giving a repository a host override, would
 * let two runs push the same branch. Its rows never influence which ID is
 * chosen: they are only ever a reason to refuse.
 *
 * Without `owner` every row counts as ours, which is the old behaviour.
 */
export function chooseWorkflowId(
  baseId: string,
  rows: readonly WorkflowIdCandidate[],
  owner?: WorkflowIdOwner,
  legacyBaseIds: readonly string[] = []
): WorkflowIdAllocation {
  const sameRepoIds = new Set(owner ? [owner.repoId, ...(owner.sameRepoIds ?? [])] : []);
  const familyRepoIds = owner ? [...sameRepoIds] : undefined;
  const bases = workflowIdFamilyBases(baseId, familyRepoIds);
  const inFamily = rows.filter((r) => bases.some((b) => familyRe(b).test(r.temporalWorkflowId)));
  const isOurs = (r: WorkflowIdCandidate) =>
    !owner ||
    ((r.repoId == null || sameRepoIds.has(r.repoId)) &&
      (owner.externalTicketId == null ||
        r.externalTicketId == null ||
        r.externalTicketId === owner.externalTicketId));
  const legacyFamilies = workflowIdFamilyBases(baseId, familyRepoIds, legacyBaseIds)
    .slice(bases.length)
    .map(familyRe);
  const legacyActive = rows.find(
    (r) =>
      legacyFamilies.some((f) => f.test(r.temporalWorkflowId)) &&
      isOurs(r) &&
      !isTerminalActiveWorkflowStatus(r.currentStatus)
  );
  if (legacyActive) {
    return { conflictWorkflowId: legacyActive.temporalWorkflowId };
  }
  const ours = inFamily.filter(isOurs);
  const active = ours.find((r) => !isTerminalActiveWorkflowStatus(r.currentStatus));
  if (active) {
    return { conflictWorkflowId: active.temporalWorkflowId };
  }
  const baseFamily = familyRe(baseId);
  const foreignInBase = inFamily.some((r) => !isOurs(r) && baseFamily.test(r.temporalWorkflowId));
  const oursInBase = ours.some((r) => baseFamily.test(r.temporalWorkflowId));
  // Stay in the base family while we are its only occupant; a foreign row there
  // means the base string is someone else's, so ours goes in the alternate one.
  const chosen =
    owner && foreignInBase && !oursInBase
      ? disambiguatedWorkflowIdBase(baseId, owner.repoId)
      : baseId;
  const used = new Set(inFamily.map((r) => r.temporalWorkflowId));
  const isRerun = ours.length > 0;
  if (!used.has(chosen)) {
    return { isRerun, workflowId: chosen };
  }
  let n = 1;
  while (used.has(`${chosen}-r${n}`)) {
    n++;
  }
  return { isRerun, workflowId: `${chosen}-r${n}` };
}
