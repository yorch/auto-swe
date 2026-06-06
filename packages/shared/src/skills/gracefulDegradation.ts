import type { BuiltinSkillDef } from './index.js';

export const GRACEFUL_DEGRADATION_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'IMPLEMENTER', sortOrder: 90 }],
  description:
    'Requires defining an explicit degraded path when non-critical dependencies fail, so partial failures do not cascade into full outages.',
  name: 'graceful-degradation',
  promptText: `## Graceful Degradation

When a non-critical dependency is unavailable, continue serving the request with reduced functionality rather than returning an error.

**Classify each dependency before writing the call:**
- *Critical* — the operation cannot proceed without it (primary DB write, auth check). Fail fast, return an appropriate error.
- *Non-critical* — enhances the response but is not required (cache, recommendation service, analytics event, feature flag). Degrade gracefully.

**For non-critical dependencies:**
- Wrap the call in a try/catch; log the failure with context but do not let the exception propagate.
- Return a sensible default or omit the optional field from the response.
- Do not retry inline — let the caller decide or use a background queue.

**Common examples:**
- Cache miss → fetch from primary store, continue without caching if the cache is down.
- External enrichment API timeout → return the base response without the enriched fields.
- Feature flag service unreachable → fall back to the safe default (flag off).
- Analytics/audit write failure → log the failure, do not roll back the primary transaction.

Document the degraded behaviour in a comment at the call site so future readers know the fallback is intentional.`,
};
