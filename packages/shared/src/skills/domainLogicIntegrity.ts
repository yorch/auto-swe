import type { BuiltinSkillDef } from './index.js';

export const DOMAIN_LOGIC_INTEGRITY_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'domainLogicReviewer', sortOrder: 10 }],
  description:
    'Focuses the domain-logic reviewer on correctness of business rules and contract compliance.',
  name: 'domain-logic-integrity',
  promptText: `## Domain Logic Integrity

When reviewing domain logic, focus on correctness over style:

1. **Business-rule coverage** — does the implementation handle all branches the original request implied? Are edge cases (empty input, boundary values, concurrent updates) accounted for?
2. **API contract stability** — any change to a public endpoint's response shape, status codes, or error codes is a breaking change; flag it even if tests pass
3. **State-machine validity** — if the code manages a state machine (workflow status, order lifecycle, etc.), verify that invalid transitions are rejected and that terminal states are truly terminal
4. **Idempotency** — operations on shared resources should be safe to retry; check that repeated calls produce the same result
5. **Data integrity on failure** — if a multi-step operation fails mid-way, are resources left in a consistent state or is cleanup guaranteed (try/finally, transaction rollback)?

Cross-reference the success criteria from the work request when available and flag each unmet criterion explicitly.`,
};
