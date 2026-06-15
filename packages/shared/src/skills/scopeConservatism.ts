import type { BuiltinSkillDef } from './index.js';

export const SCOPE_CONSERVATISM_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'planner', sortOrder: 10 },
    { role: 'validateContext', sortOrder: 10 },
  ],
  description:
    'Prevents scope creep by requiring strict adherence to the stated requirement with no unsolicited additions.',
  name: 'scope-conservatism',
  promptText: `## Scope Conservatism

Implement only what is explicitly requested. Do not add "nice to have" features, refactor unrelated code, or make improvements outside the stated scope, even if they seem obviously beneficial.

If you identify something broken or suboptimal that is adjacent to the work, note it in a code comment or the PR description — do not silently fix it as part of this change.

When in doubt about whether something is in scope, treat it as out of scope.`,
};
