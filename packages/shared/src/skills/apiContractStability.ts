import type { BuiltinSkillDef } from './index.js';

export const API_CONTRACT_STABILITY_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'IMPLEMENTER', sortOrder: 120 },
    { role: 'REVIEWER', sortOrder: 50 },
  ],
  description:
    'Requires that public APIs evolve additively only, with removals and renames treated as breaking changes requiring a deprecation cycle.',
  name: 'api-contract-stability',
  promptText: `## API Contract Stability

Once an API is consumed by any external caller — another service, the CLI, the web client, a webhook receiver — its contract is a commitment. Treat changes to it accordingly.

**Additive changes are safe (no version bump required):**
- Adding a new optional request field
- Adding a new response field (callers that don't know about it will ignore it)
- Adding a new endpoint or route
- Adding a new enum value (only if callers handle unknown values gracefully)

**Breaking changes require a deprecation cycle or version bump:**
- Removing a request or response field
- Renaming a field or route
- Changing the type of an existing field
- Changing the semantics of an existing field (e.g. a boolean that used to mean X now means Y)
- Changing a 200 response to a 4xx for a previously valid input
- Removing an enum value

**When you must make a breaking change:**
1. Add the new form alongside the old (both work)
2. Mark the old form as deprecated in code comments and API docs
3. Remove the old form only after all consumers have migrated

**Review checklist** — flag any diff that:
- Removes a field from a response schema
- Renames a route without keeping the old route as a redirect or alias
- Removes or renames a query/path parameter
- Changes a previously optional field to required`,
};
