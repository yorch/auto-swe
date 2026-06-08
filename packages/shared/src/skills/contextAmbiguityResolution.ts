import type { BuiltinSkillDef } from './index.js';

export const CONTEXT_AMBIGUITY_RESOLUTION_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'VALIDATE_CONTEXT', sortOrder: 20 }],
  description:
    'Guides how to surface and resolve ambiguities in a work request before implementation begins.',
  name: 'context-ambiguity-resolution',
  promptText: `## Context Ambiguity Resolution

Before finalising the context snapshot, identify any ambiguities that would block a correct implementation:

- **Missing constraints**: no error-handling policy stated, no auth requirement, no pagination limit — note each explicitly
- **Conflicting signals**: the ticket body contradicts its title, or acceptance criteria conflict with each other — flag the contradiction
- **Undefined terms**: business terms, service names, or acronyms that are not self-evident from context — call them out

For each ambiguity, include a placeholder criterion in the format:
  \`AMBIGUOUS: <what is unclear and why it matters>\`

This lets the implementer agent surface gaps to reviewers rather than guessing silently, and it signals to the review network that human clarification may be needed.`,
};
