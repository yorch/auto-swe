import type { BuiltinSkillDef } from './index.js';

export const CONFIGURATION_OVER_HARDCODING_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'IMPLEMENTER', sortOrder: 140 },
    { role: 'PLANNER', sortOrder: 60 },
  ],
  description:
    'Requires that operational parameters (timeouts, limits, thresholds) are configurable rather than hardcoded constants, enabling tuning without a code deploy.',
  name: 'configuration-over-hardcoding',
  promptText: `## Configuration Over Hardcoding

Operational parameters buried in code require a deploy to change. Anything an operator might need to tune in production must be configurable.

**Extract to configuration when the value is:**
- A timeout or retry count (network call, job deadline, polling interval)
- A rate limit, concurrency limit, or batch size
- A threshold or cutoff (similarity score, minimum cluster size, cost budget)
- A feature toggle or kill switch
- An external service URL, bucket name, or queue name

**Configuration sources in order of preference:**
1. DB-backed admin config (survives deploys, changeable without restart) — use this for values that operators tune at runtime
2. Environment variable (requires restart, but no code change) — use this for infrastructure settings that rarely change
3. Named constant at the top of the file — acceptable for values that are fixed by design (protocol version numbers, format strings)

**Never hardcode:**
- Magic numbers with no name or context
- Values that differ between environments (dev/staging/prod) without a config hook
- Limits that will obviously need tuning as load grows (page sizes, timeouts, retry counts)

When introducing a new configurable value, add it to the relevant config schema and document the default and the valid range.`,
};
