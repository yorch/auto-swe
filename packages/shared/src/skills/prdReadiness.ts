import type { BuiltinSkillDef } from './index.js';

export const PRD_READINESS_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'productAnalyst', sortOrder: 10 }],
  description:
    'Guides product analysis by checking a brief for goals, audience, success criteria, non-goals, and explicit scope boundaries before drafting a PRD.',
  name: 'prd-readiness',
  promptText: `## PRD Readiness

When you receive a product brief or PRD, first check that it contains enough information for engineering to act on it. Do not start writing new content until the following are clear:

1. **Goal and audience.** What business outcome is this meant to achieve, and for which user or stakeholder?
2. **Target user and context.** Who will use this, and in what situation?
3. **Success criteria.** How will we know it works? Prefer measurable or observable criteria over vague adjectives like "better" or "faster".
4. **Non-goals and scope boundaries.** What is explicitly out of scope? What is the product team saying "no" to for now?
5. **Dependencies and constraints.** Are there external teams, systems, compliance, timeline, or platform limits that shape the solution?
6. **Assumptions and open questions.** What is the brief taking for granted? What is still unknown?

If any of these are missing or ambiguous, call out the specific gap as a question for the requester. Only proceed to analysis once the gap is either resolved or explicitly declared out of scope.`,
};
