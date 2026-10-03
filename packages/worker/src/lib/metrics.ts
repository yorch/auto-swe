import { metrics } from '@opentelemetry/api';

/**
 * Application metrics, exported over OTLP by the worker's
 * `PeriodicExportingMetricReader`. Without `OTEL_EXPORTER_OTLP_ENDPOINT` no
 * MeterProvider is registered and every instrument here is a no-op.
 *
 * Attributes are deliberately low-cardinality: model spec, agent key, activity
 * type, status, source. Never a run, workflow, or ticket ID — those belong on spans and
 * trace rows, where cardinality is free.
 *
 * Units in braces are annotations, so Prometheus names come out as
 * `llm_calls_total`, `llm_tokens_total`, `llm_cost_usd_total`,
 * `workflow_runs_finalized_total`, `workflow_budget_exceeded_total`, and
 * `activity_duration_seconds_*` (not `temporal_*`, which is Temporal Core's
 * own runtime metrics' prefix).
 */

/**
 * Every `(source, status)` pair this process can finalize, and every budget
 * tier. `source` names the path that finalized the run: `worker` is
 * `finalizeWorkflowRun`, `channel` is `finalizeChannelRun`, `eval` is an
 * `EvalRun` verdict. The gateway records `gateway` (a dashboard cancel) and
 * `eval` (an eval run that failed to start) itself.
 */
const RUN_SOURCES = {
  channel: ['SUCCESS', 'FAILED'],
  eval: ['SUCCESS', 'REGRESSION', 'FAILED'],
  worker: ['SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED', 'CANCELLED'],
} as const;
export type RunFinalizedSource = keyof typeof RUN_SOURCES;
const BUDGET_TIERS = ['STANDARD', 'LARGE', 'EPIC'] as const;

function createInstruments() {
  const meter = metrics.getMeter('auto-swe-worker');
  const instruments = {
    activityDuration: meter.createHistogram('activity.duration', {
      advice: {
        // Activities range from sub-second DB writes to multi-hour implementation loops.
        explicitBucketBoundaries: [
          0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400,
        ],
      },
      description: 'Wall-clock duration of Temporal activity attempts, by outcome',
      unit: 's',
    }),
    budgetExceeded: meter.createCounter('workflow.budget_exceeded', {
      description:
        'LLM calls that ended with their workflow over its budget tier. Concurrent calls ' +
        'that finish over the cap each count, so one run can count more than once.',
      unit: '{call}',
    }),
    llmCalls: meter.createCounter('llm.calls', {
      description:
        'Agent generate calls and embedding calls. One agent call can make several model ' +
        'round trips inside its tool loop.',
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
      description:
        'Runs finalized, by status and by the path that finalized them (source): worker, ' +
        'channel, eval, or gateway (a dashboard cancel). Each run counts once.',
      unit: '{run}',
    }),
  };
  // Prometheus `increase()` reads a series' first sample as its baseline, so a
  // counter born at 1 shows no increase: the first budget breach after a
  // restart would never appear. Exporting a zero first gives it a baseline.
  // Only label sets known up front can be seeded; a model or agent's first
  // call after a restart is still invisible to `increase()`.
  for (const [source, statuses] of Object.entries(RUN_SOURCES)) {
    for (const status of statuses) {
      instruments.runsFinalized.add(0, { source, status });
    }
  }
  for (const tier of BUDGET_TIERS) {
    instruments.budgetExceeded.add(0, { tier });
  }
  return instruments;
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

/**
 * Create the instruments at boot, after `initTelemetry()`, and export once
 * straight away, so the seeded zeros reach Prometheus before the first real
 * event — not in the same periodic export as it, which would make that event
 * the series' first sample again.
 *
 * Not awaited: an unreachable collector must not hold up worker boot.
 */
export function initMetrics(): void {
  instruments();
  const provider = metrics.getMeterProvider() as { forceFlush?: () => Promise<void> };
  provider.forceFlush?.().catch(() => {
    // Exporting is best-effort; the periodic reader retries on its own interval.
  });
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

/** Call only from the attempt that actually finalized the run, so a retry cannot count it twice. */
export function recordRunFinalized(status: string, source: RunFinalizedSource): void {
  instruments().runsFinalized.add(1, { source, status });
}

export function recordBudgetExceeded(tier: string): void {
  instruments().budgetExceeded.add(1, { tier });
}

export function recordActivityDuration(
  activity: string,
  outcome: 'success' | 'failure' | 'cancelled',
  seconds: number
): void {
  instruments().activityDuration.record(seconds, { activity, outcome });
}
