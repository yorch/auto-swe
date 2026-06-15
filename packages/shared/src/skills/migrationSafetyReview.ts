import type { BuiltinSkillDef } from './index.js';

export const MIGRATION_SAFETY_REVIEW_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'reviewer', sortOrder: 30 }],
  description:
    'Ensures reviewers verify that database migrations are backwards-compatible, rollbackable, and safe to deploy without downtime.',
  name: 'migration-safety-review',
  promptText: `## Migration Safety Review

When the diff includes a Prisma migration file, verify each of the following:

**Backwards compatibility**
- Adding a NOT NULL column without a default → **reject**: old application code will fail to insert until deployed. Require a nullable column first, then a follow-up migration after deploy.
- Renaming a column or table → **reject** unless a transition alias (view or generated column) exists for the old name.
- Dropping a column or table → **reject** unless the application code referencing it was removed in a prior deploy.

**Rollback safety**
- Every migration must be reversible by the next deploy without data loss. If it is not, the PR description must include an explicit rollback procedure.

**Lock risk**
- \`ALTER TABLE … ADD COLUMN … DEFAULT <expr>\` on a large table rewrites the whole table in Postgres < 11 — flag for tables expected to exceed 1M rows.
- Adding a non-partial unique index locks the table for the duration of the index build — flag unless \`CONCURRENTLY\` is used.

**Data integrity**
- Verify foreign key additions include \`ON DELETE\` / \`ON UPDATE\` semantics appropriate for the relationship.
- Verify \`@@unique\` / \`@unique\` additions won't violate constraints on existing data.

A migration that fails any of the above is grounds to reject the PR regardless of other findings.`,
};
