import type { BuiltinSkillDef } from './index.js';

export const ROLLBACK_FIRST_PLANNING_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'planner', sortOrder: 70 }],
  description:
    'Requires defining a rollback strategy before planning implementation, so high-risk changes have an explicit escape hatch before any code is written.',
  name: 'rollback-first-planning',
  promptText: `## Rollback-First Planning

Before writing an implementation plan, define how to undo the change if it causes problems in production.

**Classify the rollback complexity:**

*Trivial* — reverting the deploy is sufficient. No data migration, no external state change. Example: updating a UI label, changing a log message.

*Managed* — rollback requires a follow-up action but it is well-defined. Document the action explicitly. Example: a nullable column was added → drop it on rollback.

*Complex* — rollback requires a forward-only migration because state has changed in a way that cannot be undone by reverting code. Example: data was transformed and the old format discarded, an external API was called with side effects (email sent, payment charged).

**Rules:**
- If rollback is *trivial*, proceed without special handling.
- If rollback is *managed*, include the rollback steps in the plan and in the PR description.
- If rollback is *complex*, the plan must include a feature flag or a phased rollout so the change can be disabled without a data rollback. Raise this as a risk in the PR description.

**High-risk signals that always require a rollback plan:**
- DB schema changes (especially dropping columns or changing types)
- Data backfills or transformations
- Changes to an external service integration (payment provider, OAuth flow, webhook contract)
- Changes to a security boundary (auth middleware, permission check, token format)

Do not begin implementation planning until the rollback classification is stated.`,
};
