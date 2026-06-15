import type { BuiltinSkillDef } from './index.js';

export const FOLLOW_EXISTING_PATTERNS_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'implementer', sortOrder: 10 }],
  description:
    'Requires reading adjacent code before writing, to ensure new code matches established conventions exactly.',
  name: 'follow-existing-patterns',
  promptText: `## Follow Existing Patterns

Before writing any new code, read the files adjacent to your change. Identify:
- Naming conventions (variable names, function names, file names)
- Error handling patterns (try/catch shape, error types thrown)
- Import style (type-only imports, barrel re-exports)
- Code organization (where helpers live, how modules are structured)

Match those patterns exactly. Do not introduce a new pattern when an existing one covers the case, even if you prefer the new one.`,
};
