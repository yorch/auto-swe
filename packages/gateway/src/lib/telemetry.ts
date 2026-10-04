import {
  resolveOtelExporterEndpoint,
  resolveOtelMetricExportInterval,
} from '@auto-swe/shared/lib/systemConfig';
import { initTelemetry as initSharedTelemetry } from '@auto-swe/shared/lib/telemetry';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

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
      // Fastify's logger is pino. This stamps trace_id/span_id on every line it
      // writes to stdout and also emits each as an OTLP log record, so the
      // gateway's logs reach Loki with their trace.
      new PinoInstrumentation(),
    ],
    logRecordProcessors: endpoint
      ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint }) })]
      : undefined,
    // Same reader as the worker's; the gateway's metrics are in lib/metrics.ts.
    metricReader: endpoint
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: endpoint }),
          exportIntervalMillis: resolveOtelMetricExportInterval(),
        })
      : undefined,
    serviceName,
    traceExporter: endpoint ? new OTLPTraceExporter({ url: endpoint }) : undefined,
  });
}
