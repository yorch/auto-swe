import type { BuiltinSkillDef } from './index.js';

export const TEST_FIRST_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'implementer', sortOrder: 20 },
    { role: 'planner', sortOrder: 20 },
  ],
  description:
    'Mandates writing or updating tests before or alongside implementation code, with explicit fail-then-pass verification.',
  name: 'test-first',
  promptText: `## Test First

Write or update tests before or alongside the implementation — never after.

- For new behaviour: write the test first (red), then the implementation (green)
- For bug fixes: add a failing test that reproduces the bug before fixing it
- For refactors: confirm existing tests pass before and after the change

Co-locate test files next to the source file they cover (e.g., \`foo.test.ts\` next to \`foo.ts\`). Use \`vitest\` — the project test runner. Do not skip or stub assertions to make tests pass artificially.`,
};
