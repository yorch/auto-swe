import {
  resolveOtelExporterEndpoint,
  resolveOtelMetricExportInterval,
} from '@auto-swe/shared/lib/systemConfig';
import { initTelemetry as initSharedTelemetry } from '@auto-swe/shared/lib/telemetry';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

export function initTelemetry(serviceName: string): { shutdown: () => Promise<void> } {
  const endpoint = resolveOtelExporterEndpoint();
  return initSharedTelemetry({
    esmModules: ['http', 'https'],
    // Undici is global `fetch`, which the AI SDK providers and Octokit call
    // through; `http` never sees it. It hooks diagnostics channels, so it needs
    // no module patching.
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
    metricReader: endpoint
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: endpoint }),
          // Standard OTel env-var convention; defaults to 30s when unset/invalid.
          exportIntervalMillis: resolveOtelMetricExportInterval(),
        })
      : undefined,
    serviceName,
    traceExporter: endpoint ? new OTLPTraceExporter({ url: endpoint }) : undefined,
  });
}
