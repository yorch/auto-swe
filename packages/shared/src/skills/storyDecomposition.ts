import type { BuiltinSkillDef } from './index.js';

export const STORY_DECOMPOSITION_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'prdWriter', sortOrder: 10 }],
  description:
    'Guidance for turning a product requirements document into a set of small, independently valuable user stories.',
  name: 'story-decomposition',
  promptText: `## Story Decomposition

When decomposing a PRD into user stories, follow these rules:

1. **Each story delivers user value on its own.** If a story only makes sense as part of a larger batch, split differently or group it as a task inside a larger story.
2. **Use the "As a [role], I want [action] so that [benefit]" form only when it clarifies the value.** If the value is obvious or the audience is the team, a clear action is enough.
3. **Keep stories small enough to implement and test in a single cycle.** A story should have one primary acceptance path and a few focused edge cases.
4. **Name dependencies explicitly.** If a story cannot start until another is complete, state the blocker. Do not bury dependencies in the description.
5. **Avoid engineering implementation details.** Stories describe "what" and "why"; the team will decide "how".
6. **Group related stories into epics or themes only when they share a clear outcome.** Do not create epics just for classification.

If a requirement is too large or too vague to decompose, ask for clarification rather than force it into an arbitrary list.`,
};
