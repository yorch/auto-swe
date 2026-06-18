import type { BuiltinSkillDef } from './index.js';

export const ERROR_PATH_COVERAGE_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'reviewer', sortOrder: 20 }],
  description:
    'Ensures reviewers verify that all error paths, 4xx/5xx responses, and not-found cases are explicitly handled and tested.',
  name: 'error-path-coverage',
  promptText: `## Error Path Coverage

During review, verify that every error path is explicitly handled:

- **catch blocks** — must not be empty or log-only. Every \`catch\` should either re-throw, transform the error, or take a meaningful recovery action.
- **HTTP endpoints** — every handler must return an appropriate 4xx/5xx for all failure modes (not-found, unauthorised, validation failure, downstream error).
- **Database queries** — \`findFirst\`/\`findUnique\` results must be null-checked before use; missing records should produce a 404, not a 500.
- **Temporal activities** — non-retriable errors must be explicitly thrown as \`ApplicationFailure.nonRetryable()\`; all others should propagate for Temporal to retry.

Flag any path where an error is silently swallowed or where a missing null-check could cause an unhandled exception.`,
};
