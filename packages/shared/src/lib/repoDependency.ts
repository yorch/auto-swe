/**
 * Shared constants and naming for the repo dependency graph. Kept here so the gateway Zod
 * enum and the web picker derive the same kind list instead of duplicating an
 * executable literal that can drift. The `status`/`source` domains are enforced
 * by CHECK constraints in the `00000000000001_custom_constraints_and_indexes` migration.
 */

/** Edge semantics. */
export const EDGE_KINDS = ['code', 'runtime', 'build', 'api', 'data'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Longest rendered label. Repo names are unbounded `text` in the DB. */
const MAX_LABEL_CHARS = 80;

/**
 * Flatten a repo-supplied name into one short, inert line.
 *
 * These labels reach agent prompts, and org/repo names are operator-supplied
 * with no charset or length limit at the API. Left raw, a repo named with
 * newlines and markdown headings can close the surrounding context block and
 * append instructions of its own. Collapsing whitespace removes the line breaks
 * such a payload needs, and the cap stops one name from crowding out a prompt.
 */
export function sanitizeRepoLabel(raw: string): string {
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

/**
 * `org/repo` when both halves are known, else a display name, else the id —
 * always sanitized, because every caller renders this somewhere a repo name
 * should not be able to act.
 */
export function repoLabel(repo: {
  id: string;
  name?: string | null;
  organizationName: string | null;
  repoName: string | null;
}): string {
  const raw =
    repo.organizationName && repo.repoName
      ? `${repo.organizationName}/${repo.repoName}`
      : (repo.repoName ?? repo.name ?? repo.id);
  return sanitizeRepoLabel(raw);
}
