import { isTerminalActiveWorkflowStatus } from '../types/api.js';

/**
 * Generate the base Temporal workflow ID for a ticket in one repository:
 * `eng-<org>-<repo>-<ticket>`.
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
  const host = githubUrl ? hostSegment(githubUrl) : null;
  return host
    ? `eng-${host}-${organizationName}-${repoName}-${externalTicketId}`
    : `eng-${organizationName}-${repoName}-${externalTicketId}`;
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
 * when the repository has a host override (see {@link chooseWorkflowId}).
 */
export function workflowIdFamilyBases(
  baseId: string,
  repoId?: string | null,
  legacyBaseId?: string | null
): string[] {
  const bases = repoId ? [baseId, disambiguatedWorkflowIdBase(baseId, repoId)] : [baseId];
  return legacyBaseId && legacyBaseId !== baseId ? [...bases, legacyBaseId] : bases;
}

/**
 * Decide the workflow ID for a new submission from the existing rows in its
 * family (see {@link workflowIdFamilyBases}).
 *
 * - A non-terminal row that is ours → conflict (the ticket is still running).
 * - Rows owned by a different repository or ticket are never a conflict: they
 *   only share our ID *string*. If one sits in the base family we move to the
 *   {@link disambiguatedWorkflowIdBase} family.
 * - Otherwise the first unused ID in the chosen family: the base, then `-r1`,
 *   `-r2`, … — `isRerun` when we have run this ticket before.
 *
 * `legacyBaseId` is the id the same ticket had before repository ids carried
 * their host (only a repository with a host override has one). An execution of
 * OUR repository still in flight under it blocks a second one exactly as one
 * under `baseId` does — otherwise the upgrade, or giving a repository a host
 * override, would let two runs push the same branch. Its rows never influence
 * which ID is chosen: they are only ever a reason to refuse.
 *
 * Without `owner` every row counts as ours, which is the old behaviour.
 */
export function chooseWorkflowId(
  baseId: string,
  rows: readonly WorkflowIdCandidate[],
  owner?: { repoId: string; externalTicketId?: string },
  legacyBaseId?: string | null
): WorkflowIdAllocation {
  const bases = workflowIdFamilyBases(baseId, owner?.repoId);
  const inFamily = rows.filter((r) => bases.some((b) => familyRe(b).test(r.temporalWorkflowId)));
  const isOurs = (r: WorkflowIdCandidate) =>
    !owner ||
    ((r.repoId == null || r.repoId === owner.repoId) &&
      (owner.externalTicketId == null ||
        r.externalTicketId == null ||
        r.externalTicketId === owner.externalTicketId));
  if (legacyBaseId && legacyBaseId !== baseId) {
    const legacyFamily = familyRe(legacyBaseId);
    const legacyActive = rows.find(
      (r) =>
        legacyFamily.test(r.temporalWorkflowId) &&
        isOurs(r) &&
        !isTerminalActiveWorkflowStatus(r.currentStatus)
    );
    if (legacyActive) {
      return { conflictWorkflowId: legacyActive.temporalWorkflowId };
    }
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
