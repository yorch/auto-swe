import type { BuiltinSkillDef } from './index.js';

export const ACTIONABLE_LESSONS_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'COMMIT_TO_MEMORY', sortOrder: 10 }],
  description:
    'Guides the memory agent to produce root-cause-first, transferable lessons with specific fix patterns rather than vague summaries.',
  name: 'actionable-lessons',
  promptText: `## Actionable Lessons

When summarising a completed workflow into a memory lesson:

1. **Root cause first** — state the underlying cause before the symptom (e.g. "Temporal activity timed out because the Docker exec call had no timeout, not because the task was too complex")
2. **Specific fix pattern** — describe the concrete change that would prevent recurrence (e.g. "Add a 30-second timeout to every \`exec()\` call in workspace activities")
3. **Transferable** — phrase the lesson so a future agent working on a different task in the same codebase can apply it without knowing the original context
4. **Avoid vagueness** — do not write lessons like "be more careful" or "test more thoroughly"; name the specific check, guard, or pattern that was missing
5. **One lesson, one root cause** — if multiple independent things went wrong, write separate lessons rather than conflating them into one`,
};
