import type { BuiltinSkillDef } from './index.js';

export const NO_NEW_DEPENDENCIES_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'implementer', sortOrder: 40 },
    { role: 'planner', sortOrder: 30 },
  ],
  description:
    'Requires checking existing dependencies and Node.js built-ins before adding any new packages to the project.',
  name: 'no-new-dependencies',
  promptText: `## No New Dependencies

Before adding any npm/yarn package, check:
1. Whether the project already has a dependency that covers the need (search \`package.json\` files and \`node_modules\`)
2. Whether Node.js built-ins cover the need (\`node:crypto\`, \`node:fs\`, \`node:path\`, etc.)
3. Whether the functionality can be implemented inline with a small, maintainable helper

Only add a new dependency if none of the above apply. When you do add one, explain in the PR description why existing options were insufficient.`,
};
