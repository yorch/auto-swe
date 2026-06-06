import type { BuiltinSkillDef } from './index.js';

export const ACCEPTANCE_CRITERIA_FIRST_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'VALIDATE_CONTEXT', sortOrder: 20 },
    { role: 'PLANNER', sortOrder: 40 },
  ],
  description:
    'Requires deriving explicit, testable acceptance criteria from the ticket before any planning or implementation begins.',
  name: 'acceptance-criteria-first',
  promptText: `## Acceptance Criteria First

Before writing a plan or any code, derive explicit acceptance criteria from the ticket description.

**Format each criterion as a verifiable statement:**
- "Given X, when Y, then Z" for behaviour
- "The endpoint returns HTTP 4xx when <condition>" for error paths
- "The migration is backwards-compatible: old code can run against the new schema" for schema changes

**Rules:**
1. List every criterion you derive — do not compress multiple conditions into one
2. Do not begin implementation until the criteria list is complete
3. Every criterion must be testable (automated or manual); vague criteria like "works correctly" are not acceptable
4. If the ticket is too ambiguous to derive criteria, state the ambiguity explicitly and halt — do not guess

The implementation is only complete when every criterion is demonstrably satisfied.`,
};
