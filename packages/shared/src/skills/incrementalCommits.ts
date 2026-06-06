import type { BuiltinSkillDef } from './index.js';

export const INCREMENTAL_COMMITS_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'IMPLEMENTER', sortOrder: 30 }],
  description:
    'Requires one logical change per commit with conventional prefixes, ensuring each commit leaves the codebase in a passing state.',
  name: 'incremental-commits',
  promptText: `## Incremental Commits

Commit one logical change at a time. Each commit must:
1. Leave the codebase in a passing state (tests green, types check, no lint errors)
2. Have a concise message with a conventional prefix: \`feat:\`, \`fix:\`, \`refactor:\`, \`test:\`, \`docs:\`, \`chore:\`
3. Cover only the work described — do not batch unrelated changes

Do not create a single "big bang" commit at the end. Commit incrementally as work progresses.`,
};
