import { resolveOtelExporterEndpoint } from '@auto-swe/shared/lib/systemConfig';
import { initTelemetry as initSharedTelemetry } from '@auto-swe/shared/lib/telemetry';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

export function initTelemetry(serviceName: string): { shutdown: () => Promise<void> } {
  const endpoint = resolveOtelExporterEndpoint();
  return initSharedTelemetry({
    esmModules: ['http', 'https', 'fastify'],
    // Undici is global `fetch` (Octokit, the tracker and knowledge-base
    // connectors); `http` never sees it.
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      new UndiciInstrumentation(),
    ],
    serviceName,
    traceExporter: endpoint ? new OTLPTraceExporter({ url: endpoint }) : undefined,
  });
}
