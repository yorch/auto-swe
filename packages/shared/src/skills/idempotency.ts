import type { BuiltinSkillDef } from './index.js';

export const IDEMPOTENCY_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'implementer', sortOrder: 80 },
    { role: 'planner', sortOrder: 50 },
  ],
  description:
    'Requires designing operations to be safe to retry: unique keys, upserts, and check-then-act patterns for any mutating call.',
  name: 'idempotency',
  promptText: `## Idempotency

Design every mutating operation to be safe to call more than once with the same inputs.

**Database writes**
- Use \`upsert\` (or \`INSERT … ON CONFLICT DO UPDATE\`) instead of blind \`insert\` when the caller might retry.
- Add unique constraints on natural keys (e.g. \`(userId, resourceId)\`) so duplicate rows are impossible, not just unlikely.

**External API calls**
- Pass a caller-supplied idempotency key when the API supports it (Stripe, SendGrid, etc.).
- Cache the result of a completed call so a retry returns the same response without re-executing side effects.

**Background jobs and queue consumers**
- Write consumers so that processing the same message twice produces the same final state.
- Record a \`processedAt\` timestamp or a dedupe key before doing work, not after.

**HTTP endpoints**
- PUT and PATCH must be idempotent by definition — ensure your implementation honours this.
- POST that creates a resource should accept and honour a client-supplied idempotency key header.

Before implementing any operation that writes data or triggers an external action, state explicitly how it handles a duplicate call.`,
};
