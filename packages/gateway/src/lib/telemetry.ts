import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { initTelemetry as initSharedTelemetry } from '@auto-swe/shared/lib/telemetry';

export function initTelemetry(serviceName: string): { shutdown: () => Promise<void> } {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return initSharedTelemetry({
    serviceName,
    traceExporter: endpoint ? new OTLPTraceExporter({ url: endpoint }) : undefined,
    instrumentations: [new HttpInstrumentation(), new FastifyInstrumentation()],
  });
}
