import type { BuiltinSkillDef } from './index.js';

export const DOCUMENTATION_ACCURACY_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'docsMaintainer', sortOrder: 10 }],
  description:
    'Keeps repository documentation true to the code: verify every claim against the source, describe the present tense, and never document what was not read.',
  name: 'documentation-accuracy',
  promptText: `## Documentation Accuracy

When you write or update documentation:

1. **Verify before you write.** Every file name, command, flag, environment variable, configuration key, default and example must be one you read in the code or a manifest in this run. If you cannot find it, leave it out or mark the gap.
2. **Describe what is, not what changed.** Use the present tense. Do not write dates, version history, "now supports" or "recently added"; that belongs in git history.
3. **Prefer editing to rewriting.** Change the sentence that is wrong. Keep the structure, headings and voice the repository already uses, and leave accurate sections alone.
4. **State limitations next to the feature.** A known gap goes in the document that describes the feature, in plain words.
5. **Keep it findable.** Link between pages with relative links and check each target exists. A page nothing links to is unfinished.
6. **An empty diff is a valid result.** If the documentation already matches the code, change nothing.`,
};
