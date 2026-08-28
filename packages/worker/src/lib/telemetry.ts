import {
  resolveOtelExporterEndpoint,
  resolveOtelMetricExportInterval,
} from '@auto-swe/shared/lib/systemConfig';
import { initTelemetry as initSharedTelemetry } from '@auto-swe/shared/lib/telemetry';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

export function initTelemetry(serviceName: string): { shutdown: () => Promise<void> } {
  const endpoint = resolveOtelExporterEndpoint();
  return initSharedTelemetry({
    instrumentations: [new HttpInstrumentation()],
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
