import type { BuiltinSkillDef } from './index.js';

export const SUPPORT_ESCALATION_POLICY_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'supportResponder', sortOrder: 30 }],
  description:
    'Guidelines for deciding when a ticket should be escalated and how to communicate that to the customer.',
  name: 'support-escalation-policy',
  promptText: `## Support Escalation Policy

Before finalizing a reply, decide whether the ticket can be resolved in-place or should be escalated:

1. Escalate when any of the following are present:
   - A security, billing, legal, or data-access issue.
   - A bug that the responder cannot reproduce or explain with the current information.
   - A request for a feature, refund, service change, or anything outside the support responder's authority.
   - An angry or at-risk customer, or any threat of churn or public complaint.
2. When escalating, do not attempt to solve the issue. Instead, clearly state that the case is being forwarded to the appropriate team, give a realistic expectation for follow-up, and thank the customer.
3. When not escalating, answer directly. Provide the next step the customer can take or the information they need.
4. If the ticket is missing information needed to decide, ask one or two specific questions before classifying.`,
};
