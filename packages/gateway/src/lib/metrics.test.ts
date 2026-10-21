import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetMetricsForTests,
  initMetrics,
  recordActivityEventsDropped,
  recordHttpDenied,
  recordRunFinalized,
  recordTranscriptAccessLogFailure,
} from './metrics.js';

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

  it('counts transcript access-log failures by action, seeded at zero', async () => {
    initMetrics();
    recordTranscriptAccessLogFailure('content_read');
    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === 'transcript.access_log_failures');
    const points = (metric?.dataPoints ?? []).map((d) => [d.attributes.action, d.value]);
    expect(points).toContainEqual(['content_read', 1]);
    expect(points).toContainEqual(['export', 0]);
  });

  it('counts denials by route template, status and whether an actor was known', async () => {
    initMetrics();
    recordHttpDenied('/api/v1/platform/audit-log', 403, false);
    recordActivityEventsDropped(3);
    const { resourceMetrics } = await reader.collect();
    const all = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    const denied = (all.find((m) => m.descriptor.name === 'http.denied')?.dataPoints ?? []).map(
      (d) => [d.attributes.route, d.attributes.status, d.attributes.actor, d.value]
    );
    expect(denied).toContainEqual(['/api/v1/platform/audit-log', 403, 'none', 1]);
    expect(denied).toContainEqual(['none', 401, 'known', 0]);
    const dropped = all.find((m) => m.descriptor.name === 'activity.events.dropped');
    expect(dropped?.dataPoints.map((d) => d.value)).toEqual([3]);
  });
});
