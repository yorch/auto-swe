import type { BuiltinSkillDef } from './index.js';

export const DOCUMENT_REVIEW_RUBRIC_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'docReviewer', sortOrder: 10 }],
  description:
    'Guidance for reviewing a document against stated criteria: anchored, graded findings and an honest readiness verdict.',
  name: 'document-review-rubric',
  promptText: `## Document Review Rubric

When you review a document:

1. **Criteria first.** Check each stated criterion in turn and report where the document misses it. Add a finding of your own only when a gap would stop the next step, such as a contradiction or an undefined term the document depends on.
2. **Anchor every finding.** Name the section and quote a short excerpt so the author can find the exact place. A finding the author cannot locate is not actionable.
3. **Grade honestly.** A blocker stops the next step. A major finding will cause rework. Do not inflate a style point into a blocker to look thorough, and do not downgrade a real gap to be agreeable.
4. **Ready means ready.** Mark the document ready only with no blocker and no major finding. A document that is nearly ready is not ready.
5. **Say what would fix it.** Name the missing fact, the decision, or the question to answer. Do not write the author's text for them.
6. **Report each problem once.** Several symptoms of one gap are one finding.`,
};
