import type { BuiltinSkillDef } from './index.js';

export const PRODUCT_ACCEPTANCE_CRITERIA_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'productAnalyst', sortOrder: 20 },
    { role: 'prdWriter', sortOrder: 20 },
  ],
  description:
    'Product-specific guidance for writing acceptance criteria that are testable, user-centered, and bounded.',
  name: 'product-acceptance-criteria',
  promptText: `## Product Acceptance Criteria

Acceptance criteria are the bridge between a requirement and a test. Use this guidance for every feature or story you work with:

1. **Write from the user's point of view.** Start with the observable behavior: what the user can do, see, or experience.
2. **Make each criterion verifiable.** A teammate should be able to check it without asking for interpretation.
3. **Use the "Given/When/Then" structure only when it adds clarity.** For simple cases, a single declarative sentence is fine.
4. **Cover the negative and edge cases explicitly.** What should happen on invalid input, empty state, or when a dependency fails?
5. **Keep criteria bounded to the described change.** Do not include unrelated system qualities unless the change directly affects them.
6. **Avoid implementation detail.** "Save to the database" is not a criterion; "the user sees a confirmation and can retrieve the saved item" is.

Do not combine multiple conditions into a single vague criterion. If a requirement has three outcomes, list three criteria.`,
};
