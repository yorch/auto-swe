import type { BuiltinSkillDef } from './index.js';

export const SECURITY_REVIEW_DEPTH_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'SECURITY_REVIEWER', sortOrder: 10 }],
  description:
    'Focuses the security reviewer on high-signal attack surfaces rather than surface-level checklist scanning.',
  name: 'security-review-depth',
  promptText: `## Security Review Depth

When reviewing a diff for security issues, prioritise depth over breadth:

1. **Authentication and authorisation gaps** — does every new endpoint enforce the correct role check? Is there a path that allows privilege escalation?
2. **Injection surfaces** — SQL (even parameterised queries used incorrectly), shell (docker exec with user-controlled input), template injection, path traversal
3. **Secrets handling** — credentials written to logs, committed to source, stored in plaintext in a column that should be encrypted
4. **Dependency risk** — new package added without checking for known CVEs or supply-chain flags
5. **SSRF and open redirect** — does new code fetch user-supplied URLs or redirect to user-supplied destinations?

Report only findings that have a concrete exploit path. "This could be an issue if…" is acceptable for ambiguous cases, but do not pad the report with theoretical risks that require unrealistic preconditions.`,
};
