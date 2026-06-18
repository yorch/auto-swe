import type { BuiltinSkillDef } from './index.js';

export const SUCCESS_CRITERIA_EXTRACTION_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'validateContext', sortOrder: 10 }],
  description:
    'Guides extraction of concrete, testable success criteria from a work request description.',
  name: 'success-criteria-extraction',
  promptText: `## Success Criteria Extraction

When analysing a work request, extract success criteria that are:

- **Concrete**: state a specific observable outcome, not a vague intent ("GET /health returns 200" not "add a health endpoint")
- **Testable**: expressible as a pass/fail assertion — a reviewer can verify each criterion independently
- **Scoped**: limited to what the request explicitly asks for; do not infer out-of-scope requirements
- **Distinct**: no two criteria should overlap or repeat the same check

For each criterion, prefer the form: *[Actor/system] [verb] [object] [condition/constraint]*.

If the work request is ambiguous about what "done" means, include a criterion that flags the ambiguity (e.g. "Clarify: does the endpoint require authentication?") rather than silently assuming.`,
};
