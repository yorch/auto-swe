import type { BuiltinSkillDef } from './index.js';

export const PR_DESCRIPTION_QUALITY_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'IMPLEMENTER', sortOrder: 70 }],
  description:
    'Requires pull request descriptions that explain the why, call out breaking changes, include migration steps, and provide a concrete test plan.',
  name: 'pr-description-quality',
  promptText: `## PR Description Quality

Every pull request description must include the following sections:

**Why** — one or two sentences explaining the motivation. Reference the ticket ID. Do not describe *what* the code does (the diff does that) — explain *why* this change is needed.

**What changed** — a bullet list of the logical changes made. Group related changes; do not list every file touched.

**Breaking changes** — explicitly state "None" or list each breaking change with:
- What breaks (API shape, CLI flag, DB schema, env var)
- Who is affected (gateway, worker, web, CLI, external callers)
- Migration path or action required before/after deploy

**Schema changes** — if a migration file is included: summarise what changed, confirm it is backwards-compatible, and describe the rollback procedure if it is not.

**Test plan** — a checklist of the specific steps to verify the change works. Each item must be concrete and actionable (not "test the feature"). Include both the happy path and at least one error/edge case.

Omitting any required section, or writing a vague/empty section, is a quality defect equivalent to missing test coverage.`,
};
