import type { BuiltinSkillDef } from './index.js';

export const SUBTASK_DECOMPOSITION_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'decomposer', sortOrder: 10 }],
  description:
    'Guides the decomposer agent to split work along feature boundaries with self-contained, merge-safe subtasks.',
  name: 'subtask-decomposition',
  promptText: `## Subtask Decomposition

When splitting a work request into subtasks:

- **Feature boundary, not layer boundary** — split by independent feature slice (auth flow, API endpoint, UI component), never by technical layer (backend, frontend, tests). Tests travel with the code they cover.
- **Self-contained descriptions** — each subtask description must be fully understood without reading the others. Include the relevant context, file paths, and constraints in the subtask body.
- **Merge-safe scope** — subtasks that touch the same file will produce merge conflicts. Prefer non-overlapping file scopes; when overlap is unavoidable, note it explicitly.
- **Singleton when appropriate** — if the request is small, tightly coupled, or would produce trivial subtasks, return a single subtask covering the whole request. Decomposition is not mandatory.
- **Maximum 8 subtasks** — enforce this hard cap; more subtasks add coordination overhead without proportional benefit.

Provide a brief rationale explaining why you chose the decomposition (or why you kept it as a singleton).`,
};
