import { initTelemetry as initSharedTelemetry } from '@auto-swe/shared/lib/telemetry';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

export function initTelemetry(serviceName: string): { shutdown: () => Promise<void> } {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return initSharedTelemetry({
    serviceName,
    traceExporter: endpoint ? new OTLPTraceExporter({ url: endpoint }) : undefined,
    metricReader: endpoint
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: endpoint }),
          exportIntervalMillis: 30_000,
        })
      : undefined,
    instrumentations: [new HttpInstrumentation()],
  });
}
