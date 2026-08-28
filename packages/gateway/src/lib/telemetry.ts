import { resolveOtelExporterEndpoint } from '@auto-swe/shared/lib/systemConfig';
import { initTelemetry as initSharedTelemetry } from '@auto-swe/shared/lib/telemetry';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

export function initTelemetry(serviceName: string): { shutdown: () => Promise<void> } {
  const endpoint = resolveOtelExporterEndpoint();
  return initSharedTelemetry({
    instrumentations: [new HttpInstrumentation(), new FastifyInstrumentation()],
    serviceName,
    traceExporter: endpoint ? new OTLPTraceExporter({ url: endpoint }) : undefined,
  });
}
