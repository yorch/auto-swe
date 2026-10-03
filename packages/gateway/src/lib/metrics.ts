import { metrics } from '@opentelemetry/api';

/**
 * The gateway's share of `workflow_runs_finalized_total` — the same instrument
 * name and description the worker exports (`worker/src/lib/metrics.ts`), told
 * apart by `source` and by the service's own `job` label. The gateway ends a
 * run in two places: a dashboard cancel (`source: gateway`) and an eval run
 * whose workflow failed to start (`source: eval`). Without
 * `OTEL_EXPORTER_OTLP_ENDPOINT` no MeterProvider is registered and this is a
 * no-op.
 */
const RUN_SOURCES = {
  eval: ['FAILED'],
  gateway: ['CANCELLED'],
} as const;
type RunSource = keyof typeof RUN_SOURCES;

function createInstruments() {
  const runsFinalized = metrics
    .getMeter('auto-swe-gateway')
    .createCounter('workflow.runs.finalized', {
      description:
        'Runs finalized, by status and by the path that finalized them (source): worker, ' +
        'channel, eval, or gateway (a dashboard cancel). Each run counts once.',
      unit: '{run}',
    });
  // Seeded at zero so Prometheus `increase()` has a baseline before the first
  // real event; see the worker's metrics module.
  for (const [source, statuses] of Object.entries(RUN_SOURCES)) {
    for (const status of statuses) {
      runsFinalized.add(0, { source, status });
    }
  }
  return { runsFinalized };
}

let cached: ReturnType<typeof createInstruments> | undefined;

/**
 * Created on first use, not at import: the metrics API has no proxy provider,
 * so a meter taken before the preload registered one would be a no-op forever.
 */
function instruments() {
  cached ??= createInstruments();
  return cached;
}

/** Create the instruments at boot and export the seeded zeros straight away. Not awaited. */
export function initMetrics(): void {
  instruments();
  const provider = metrics.getMeterProvider() as { forceFlush?: () => Promise<void> };
  provider.forceFlush?.().catch(() => {
    // Best-effort; the periodic reader retries on its own interval.
  });
}

/** For tests — rebind to the current MeterProvider. */
export function _resetMetricsForTests(): void {
  cached = undefined;
}

/** Call only from the write that actually ended the run, so a race cannot count it twice. */
export function recordRunFinalized(status: string, source: RunSource): void {
  instruments().runsFinalized.add(1, { source, status });
}
