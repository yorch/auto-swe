import {
  resolveOtelExporterEndpoint,
  resolveOtelMetricExportInterval,
} from '@auto-swe/shared/lib/systemConfig';
import { initTelemetry as initSharedTelemetry } from '@auto-swe/shared/lib/telemetry';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { WorkflowSpanTarget } from './workflowSpanSink.js';

export function initTelemetry(serviceName: string): {
  shutdown: () => Promise<void>;
  /** Where workflow spans are exported; undefined when telemetry is disabled. */
  workflowSpans?: WorkflowSpanTarget;
} {
  const endpoint = resolveOtelExporterEndpoint();
  // One exporter behind two batch processors: the SDK's for spans a tracer ends,
  // and one for workflow spans, which carry ids chosen inside the workflow
  // isolate and so cannot come from a tracer. Batching keeps a burst of run
  // endings from exceeding the OTLP exporter's concurrent-export limit, which
  // would drop the SDK processor's batches too.
  const traceExporter = endpoint ? new OTLPTraceExporter({ url: endpoint }) : undefined;
  const telemetry = initSharedTelemetry({
    esmModules: ['http', 'https'],
    // Undici is global `fetch`, which the AI SDK providers and Octokit call
    // through; `http` never sees it. It hooks diagnostics channels, so it needs
    // no module patching.
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
    // Fed by the Temporal Runtime logger (lib/otelLogger.ts).
    logRecordProcessors: endpoint
      ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint }) })]
      : undefined,
    metricReader: endpoint
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: endpoint }),
          // Standard OTel env-var convention; defaults to 30s when unset/invalid.
          exportIntervalMillis: resolveOtelMetricExportInterval(),
        })
      : undefined,
    serviceName,
    traceExporter,
  });
  const processor =
    traceExporter && telemetry.resource ? new BatchSpanProcessor(traceExporter) : undefined;
  return {
    // The batch processor is shut down first, so its final batch reaches the
    // exporter before the SDK shuts that exporter down.
    shutdown: async () => {
      await processor?.shutdown();
      await telemetry.shutdown();
    },
    workflowSpans:
      processor && telemetry.resource ? { processor, resource: telemetry.resource } : undefined,
  };
}
