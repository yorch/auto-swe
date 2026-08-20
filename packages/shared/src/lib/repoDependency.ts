/**
 * Shared constants for the repo dependency graph. Kept here so the gateway Zod
 * enum and the web picker derive the same kind list instead of duplicating an
 * executable literal that can drift. The `status`/`source` domains are enforced
 * by CHECK constraints in the 00000000000002_repo_dependencies migration.
 */

/** Edge semantics. */
export const EDGE_KINDS = ['code', 'runtime', 'build', 'api', 'data'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
