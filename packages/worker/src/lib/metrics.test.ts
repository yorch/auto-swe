import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetMetricsForTests,
  initMetrics,
  recordActivityDuration,
  recordLlmCallMetrics,
  recordRunFinalized,
} from './metrics.js';

class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

let reader: TestReader;

async function collected() {
  const { resourceMetrics } = await reader.collect();
  return new Map(
    resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).map((m) => [m.descriptor.name, m])
  );
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

describe('worker metrics', () => {
  it('builds no instrument at import, so a provider registered later still receives data', async () => {
    // The module was imported above, before beforeEach registered a provider —
    // the order ESM gives the worker. Instruments are built on first use.
    recordRunFinalized('SUCCESS');

    const points = (await collected()).get('workflow.runs.finalized')?.dataPoints ?? [];
    expect(points.find((d) => d.attributes.status === 'SUCCESS')?.value).toBe(1);
  });

  it('seeds every status and tier at zero, so increase() sees the first real event', async () => {
    initMetrics();

    const m = await collected();
    expect(
      (m.get('workflow.runs.finalized')?.dataPoints ?? []).map((d) => [
        d.attributes.status,
        d.value,
      ])
    ).toEqual([
      ['SUCCESS', 0],
      ['FAILED', 0],
      ['TIMED_OUT', 0],
      ['SKIPPED', 0],
      ['CANCELLED', 0],
    ]);
    expect(
      (m.get('workflow.budget_exceeded')?.dataPoints ?? []).map((d) => d.attributes.tier)
    ).toEqual(['STANDARD', 'LARGE', 'EPIC']);
  });

  it('splits tokens by direction and keeps run identity out of attributes', async () => {
    recordLlmCallMetrics({
      agent: 'implementer',
      costUsd: 0.25,
      inputTokens: 1000,
      model: 'anthropic/claude-opus-4-8',
      outputTokens: 50,
    });

    const m = await collected();
    const tokens = m.get('llm.tokens')?.dataPoints ?? [];
    expect(tokens.map((d) => [d.attributes.direction, d.value])).toEqual([
      ['input', 1000],
      ['output', 50],
    ]);
    expect(m.get('llm.cost_usd')?.dataPoints[0]?.value).toBe(0.25);
    expect(Object.keys(m.get('llm.calls')?.dataPoints[0]?.attributes ?? {}).sort()).toEqual([
      'agent',
      'model',
    ]);
  });

  it('records activity durations into the histogram', async () => {
    recordActivityDuration('executeImplementation', 'failure', 42);

    const point = (await collected()).get('activity.duration')?.dataPoints[0];
    expect(point?.attributes).toEqual({ activity: 'executeImplementation', outcome: 'failure' });
    expect((point?.value as { sum: number } | undefined)?.sum).toBe(42);
  });
});
