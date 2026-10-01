import { metrics } from '@opentelemetry/api';

/**
 * Application metrics, exported over OTLP by the worker's
 * `PeriodicExportingMetricReader`. Without `OTEL_EXPORTER_OTLP_ENDPOINT` no
 * MeterProvider is registered and every instrument here is a no-op.
 *
 * Attributes are deliberately low-cardinality: model spec, agent key, activity
 * type, status. Never a run, workflow, or ticket ID — those belong on spans and
 * trace rows, where cardinality is free.
 *
 * Units in braces are annotations, so Prometheus names come out as
 * `llm_calls_total`, `llm_tokens_total`, `llm_cost_usd_total`,
 * `workflow_runs_finalized_total`, `workflow_budget_exceeded_total`, and
 * `temporal_activity_duration_seconds_*`.
 */

function createInstruments() {
  const meter = metrics.getMeter('auto-swe-worker');
  return {
    activityDuration: meter.createHistogram('temporal.activity.duration', {
      advice: {
        // Activities range from sub-second DB writes to hour-long implementation loops.
        explicitBucketBoundaries: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
      },
      description: 'Wall-clock duration of Temporal activity attempts',
      unit: 's',
    }),
    budgetExceeded: meter.createCounter('workflow.budget_exceeded', {
      description: 'LLM calls that pushed a workflow past its budget tier',
      unit: '{event}',
    }),
    llmCalls: meter.createCounter('llm.calls', {
      description: 'LLM and embedding calls',
      unit: '{call}',
    }),
    llmCost: meter.createCounter('llm.cost_usd', {
      description: 'Priced cost of LLM and embedding calls, in USD',
      unit: '{USD}',
    }),
    llmTokens: meter.createCounter('llm.tokens', {
      description: 'Tokens consumed by LLM and embedding calls',
      unit: '{token}',
    }),
    runsFinalized: meter.createCounter('workflow.runs.finalized', {
      description: 'Workflow runs reaching a terminal status',
      unit: '{run}',
    }),
  };
}

let cached: ReturnType<typeof createInstruments> | undefined;

/**
 * Created on first use, not at import. The metrics API has no proxy provider:
 * `getMeter` binds to whatever is registered *now*, and ESM evaluates every
 * static import before `index.ts` reaches `initTelemetry()` — so instruments
 * built at module load would be no-ops for the life of the process.
 */
function instruments() {
  cached ??= createInstruments();
  return cached;
}

/** For tests — rebind to the current MeterProvider. */
export function _resetMetricsForTests(): void {
  cached = undefined;
}

export function recordLlmCallMetrics(opts: {
  model: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): void {
  const i = instruments();
  const attrs = { agent: opts.agent, model: opts.model };
  i.llmCalls.add(1, attrs);
  i.llmTokens.add(opts.inputTokens, { ...attrs, direction: 'input' });
  i.llmTokens.add(opts.outputTokens, { ...attrs, direction: 'output' });
  i.llmCost.add(opts.costUsd, attrs);
}

export function recordRunFinalized(status: string): void {
  instruments().runsFinalized.add(1, { status });
}

export function recordBudgetExceeded(tier: string): void {
  instruments().budgetExceeded.add(1, { tier });
}

export function recordActivityDuration(
  activity: string,
  outcome: 'success' | 'failure',
  seconds: number
): void {
  instruments().activityDuration.record(seconds, { activity, outcome });
}
