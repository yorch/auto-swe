import type { BuiltinSkillDef } from './index.js';

export const NO_NEW_DEPENDENCIES_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'implementer', sortOrder: 40 },
    { role: 'planner', sortOrder: 30 },
  ],
  description:
    'Requires checking existing dependencies and the standard library of the language before adding any new packages to the project.',
  name: 'no-new-dependencies',
  promptText: `## No New Dependencies

Before adding any package (npm, pip, Maven/Gradle, Go module, crate, …), check:
1. Whether the project already has a dependency that covers the need (search the manifests — \`package.json\`, \`pyproject.toml\`/\`requirements.txt\`, \`pom.xml\`/\`build.gradle\`, \`go.mod\` — and the installed dependencies)
2. Whether the language's standard library covers the need (e.g. \`node:crypto\`/\`node:fs\`, Python's \`pathlib\`/\`json\`, the JDK, Go's \`net/http\`)
3. Whether the functionality can be implemented inline with a small, maintainable helper

Only add a new dependency if none of the above apply. When you do add one, explain in the PR description why existing options were insufficient.`,
};
