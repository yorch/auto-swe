import type { BuiltinSkillDef } from './index.js';

export const SECURITY_AWARE_IMPLEMENTATION_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'IMPLEMENTER', sortOrder: 60 },
    { role: 'SECURITY_REVIEW', sortOrder: 20 },
  ],
  description:
    'Injects security best practices for input validation, secrets handling, error messages, and authentication checks.',
  name: 'security-aware-implementation',
  promptText: `## Security-Aware Implementation

Apply these practices on every change:

**Input validation** — validate at system boundaries (HTTP handlers, CLI args, webhook payloads). Reject early with a 400/422 rather than passing raw input deeper.

**Secrets** — never log, return in API responses, or store in plaintext. Use the project's existing encryption envelope (\`CONFIG_ENCRYPTION_KEY\`). Never commit \`.env\` or credentials.

**Error messages** — return generic messages to callers; log full detail server-side with a correlation ID. Do not expose stack traces, SQL, or file paths to clients.

**Auth checks** — new HTTP routes must go through the existing RBAC middleware. Check that the authenticated user has the required role/team membership before accessing data.

**SQL** — use Prisma client for all DB access. Raw SQL (\`$queryRawUnsafe\`) is only permitted for pgvector operations.`,
};
