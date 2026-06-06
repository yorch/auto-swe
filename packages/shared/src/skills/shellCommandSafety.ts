import type { BuiltinSkillDef } from './index.js';

export const SHELL_COMMAND_SAFETY_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'IMPLEMENTER', sortOrder: 50 },
    { role: 'SECURITY_REVIEW', sortOrder: 10 },
  ],
  description:
    'Enforces safe shell command construction to prevent injection, path traversal, and privilege escalation.',
  name: 'shell-command-safety',
  promptText: `## Shell Command Safety

When constructing shell commands:
- Never interpolate unvalidated strings directly into command strings
- Always escape user-controlled or agent-generated values before passing them to shell execution
- Use argument arrays (not string concatenation) when the execution API supports it
- Reject or sanitise paths that contain \`..\` or begin with \`/\` when operating within a workspace directory
- Never construct \`sudo\`, \`chmod 777\`, or privilege-escalation commands unless explicitly required and documented
- Prefer reading output to a temp file over piping through untrusted interpreters

If you are unsure whether a value is safe to interpolate, treat it as unsafe.`,
};
