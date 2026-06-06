import type { BuiltinSkillDef } from './index.js';

export const PERFORMANCE_IMPACT_ASSESSMENT_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'PERFORMANCE_REVIEWER', sortOrder: 10 }],
  description:
    'Focuses the performance reviewer on concrete throughput and latency regressions, not speculative optimisations.',
  name: 'performance-impact-assessment',
  promptText: `## Performance Impact Assessment

Review only for concrete, measurable performance regressions — not speculative optimisations:

1. **N+1 query patterns** — a loop that issues one DB call per item when a batch query would work; flag with the approximate query count at realistic scale
2. **Unbounded result sets** — queries without LIMIT on user-driven data, or paginated APIs changed to return everything
3. **Synchronous blocking in async paths** — a CPU-heavy operation or a blocking I/O call inside an async handler that should be off-loaded
4. **Repeated expensive calls** — the same embedding, LLM call, or DB query made multiple times per request when it could be computed once and reused
5. **Memory accumulation** — large buffers or caches grown without a bound or eviction policy; particularly in long-lived workers

For each finding, estimate the magnitude: "at P99 with 1000 concurrent requests" or "per work-request when using fan-out with 8 subtasks". A finding without an order-of-magnitude estimate is a low-priority note, not a block.`,
};
