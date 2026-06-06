import type { BuiltinSkillDef } from './index.js';

export const OBSERVABILITY_FIRST_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'IMPLEMENTER', sortOrder: 110 }],
  description:
    'Requires adding structured log statements at key decision points, with correlation IDs and sufficient context to diagnose issues without a debugger.',
  name: 'observability-first',
  promptText: `## Observability First

Code that cannot be diagnosed from logs and metrics in production is incomplete. Add structured observability to every significant code path.

**Log at key decision points:**
- Request received (with correlation/trace ID, sanitised inputs)
- Branch taken in business logic (which path and why)
- External call made and its outcome (duration, status, sanitised response)
- Error caught (full error message + stack, correlation ID, relevant context)
- Background job started and completed (job ID, duration, result summary)

**Structured format:**
- Log objects, not string concatenation: \`logger.info({ userId, repoId, action: 'clone' }, 'workspace cloned')\`
- Include a correlation ID on every log line within a request or workflow
- Never log secrets, tokens, API keys, passwords, or PII — log masked versions or omit entirely

**Log levels:**
- \`error\` — unexpected failure that needs attention; always include the full error object
- \`warn\` — recoverable anomaly or degraded path taken
- \`info\` — significant business event (request completed, job finished, state transition)
- \`debug\` — diagnostic detail useful during development; should be off in production

**Metrics / spans (where the framework provides them):**
- Record duration for every external call (DB, HTTP, LLM)
- Increment counters for success and failure paths separately
- Use the existing tracer/OTel instrumentation — do not introduce a second observability library

Do not remove or thin out existing log statements unless they log secrets or are provably dead code.`,
};
