import type { BuiltinSkillDef } from './index.js';

export const REVIEW_FOCUS_SECURITY_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'REVIEWER', sortOrder: 10 }],
  description:
    'Directs reviewers to prioritise security findings above all other issues, with mandatory rejection on CRITICAL severity.',
  name: 'review-focus-security',
  promptText: `## Review Priority: Security First

Evaluate findings in this order of severity:
1. **CRITICAL** — auth bypass, secret exposure, RCE, SQL injection, SSRF → reject immediately; do not approve regardless of other findings
2. **HIGH** — XSS, IDOR, path traversal, missing auth check, plaintext secrets in logs → reject
3. **MEDIUM** — input not validated at boundary, error detail leaked, insecure default → reject unless low-impact context is clear
4. **LOW / INFO** — style, minor inefficiency — note but do not block approval

A single CRITICAL or HIGH finding is sufficient grounds to reject. Document the exact file and line in your rejection reason.`,
};
