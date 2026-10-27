import { z } from 'zod';

/** The `config.integration` marker that identifies a team's Qodo `mcp` Connection. */
export const QODO_INTEGRATION = 'qodo';

/**
 * The Qodo tools a read-only integration may call, named as the Qodo tool catalog names them
 * (`qodo tools help --json`, every entry with `access: read`). A tool is listed here by an
 * explicit decision: a tool Qodo adds later, or reclassifies from read to write, stays out until
 * this list is edited. `litegit-git` and `review-skills-discover` are excluded: the catalog
 * marks them write.
 */
export const QODO_READ_TOOLS: readonly string[] = [
  'litegit-blame',
  'litegit-find',
  'litegit-get-commit',
  'litegit-get-issue',
  'litegit-get-pr',
  'litegit-grep',
  'litegit-list-branches',
  'litegit-list-commits',
  'litegit-list-issues',
  'litegit-list-prs',
  'litegit-list-tags',
  'litegit-ls',
  'litegit-read-file',
  'litegit-search-issues',
  'litegit-search-repos',
  'cross-repo-overview',
  'cross-repo-pair',
  'cross-repo-relations',
  'get-pr-review-findings',
  'pull-request-by-file',
  'pull-request-details',
  'pull-request-patch',
  'pull-request-review-history',
  'pull-request-similar',
  'pull-request-similar-suggestions',
  'pull-request-stats',
  'review-notes-find-tracks',
  'review-notes-for-pr',
  'review-notes-get-pr',
  'review-notes-get-track',
  'review-notes-history',
  'review-notes-resolve-repository',
  'review-skills-discovery-status',
  'review-skills-get',
  'review-skills-insights',
  'review-skills-list',
  'review-skills-source-repositories',
  'rules-get',
  'rules-list',
  'rules-metadata',
  'rules-search',
];

/** The tool allowlist an `mcp` Connection may carry: bounded in count and name length. */
export const AllowedToolsSchema = z.array(z.string().min(1).max(128)).max(200);

/** Whether an `mcp` Connection's `config` carries the Qodo marker. */
export function isQodoConnectionConfig(config: unknown): boolean {
  return (
    typeof config === 'object' &&
    config !== null &&
    (config as { integration?: unknown }).integration === QODO_INTEGRATION
  );
}

/**
 * The tool allowlist of an `mcp` Connection's `config`, or `undefined` for no restriction.
 *
 * A stored `allowedTools` that is not a valid list resolves to `[]` (nothing binds): a corrupt
 * allowlist must never widen into "everything". A Qodo-marked connection with no list resolves to
 * {@link QODO_READ_TOOLS}, so it cannot bind unfiltered however the row was created, and a
 * stored list on a Qodo-marked connection is intersected with it, so a write tool never binds.
 * Any other connection without a list is unrestricted.
 */
export function allowedToolsOfConfig(config: unknown): readonly string[] | undefined {
  const stored =
    typeof config === 'object' && config !== null
      ? (config as { allowedTools?: unknown }).allowedTools
      : undefined;
  if (stored !== undefined) {
    const parsed = AllowedToolsSchema.safeParse(stored);
    if (!parsed.success) {
      return [];
    }
    // A Qodo connection never binds outside the read tools, whatever list was stored.
    return isQodoConnectionConfig(config)
      ? parsed.data.filter((name) => QODO_READ_TOOLS.includes(name))
      : parsed.data;
  }
  return isQodoConnectionConfig(config) ? QODO_READ_TOOLS : undefined;
}

/**
 * The names in a Qodo-marked `config`'s stored `allowedTools` that are not read tools, in stored
 * order. Empty for an unmarked config, a config with no list, or a list of read tools only.
 */
export function nonReadQodoTools(config: unknown): string[] {
  if (!isQodoConnectionConfig(config)) {
    return [];
  }
  const parsed = AllowedToolsSchema.safeParse((config as { allowedTools?: unknown }).allowedTools);
  return parsed.success ? parsed.data.filter((name) => !QODO_READ_TOOLS.includes(name)) : [];
}
