import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetMetricsForTests, initMetrics, recordRunFinalized } from './metrics.js';

class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

let reader: TestReader;

async function finalized() {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics
    .flatMap((s) => s.metrics)
    .find((m) => m.descriptor.name === 'workflow.runs.finalized');
  return (metric?.dataPoints ?? []).map((d) => [d.attributes.source, d.attributes.status, d.value]);
}

beforeEach(() => {
  reader = new TestReader();
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  _resetMetricsForTests();
});

afterEach(() => {
  metrics.disable();
  _resetMetricsForTests();
});

describe('gateway metrics', () => {
  it('seeds the runs the gateway can finalize at zero', async () => {
    initMetrics();
    expect(await finalized()).toEqual([
      ['eval', 'FAILED', 0],
      ['gateway', 'CANCELLED', 0],
    ]);
  });

  it('binds to a provider registered after import', async () => {
    recordRunFinalized('CANCELLED', 'gateway');
    expect(await finalized()).toContainEqual(['gateway', 'CANCELLED', 1]);
  });
});
