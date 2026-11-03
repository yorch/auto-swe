import type { BuiltinSkillDef } from './index.js';

export const TICKET_HIERARCHY_PLANNING_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'ticketPlanner', sortOrder: 10 }],
  description:
    'Guidance for turning a reviewed document into a small, well-formed epic, ticket and sub-task structure.',
  name: 'ticket-hierarchy-planning',
  promptText: `## Ticket Hierarchy Planning

When you propose a ticket structure:

1. **One epic, one outcome.** The epic names what the document delivers. Do not create an epic for classification.
2. **A ticket is finishable.** One person can complete and verify it. If it cannot be checked on its own, merge it into its neighbour; if it is too large to finish in one cycle, split it.
3. **Sub-tasks are for distinct steps.** Add them only where steps differ in who does them or how they are reviewed. Never add one that restates its parent.
4. **Write for a stranger.** Each description says what and why, and each acceptance criterion can be checked by someone who never saw the document.
5. **Do not ticket what is unclear.** A requirement the review flagged as unresolved is named in the rationale, not guessed into a ticket.
6. **Keep it small.** Fewer well-formed tickets beat many thin ones, and a person has to review all of them.`,
};
