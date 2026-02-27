import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

/**
 * Initializes OpenTelemetry for the worker service.
 * Must be called BEFORE any other imports that should be instrumented.
 * No-ops gracefully when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
 */
export function initTelemetry(serviceName: string): { shutdown: () => Promise<void> } {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!endpoint) {
    console.log(`OTel: no OTEL_EXPORTER_OTLP_ENDPOINT set, telemetry disabled`);
    return { shutdown: async () => {} };
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}` }),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [new HttpInstrumentation()],
  });

  sdk.start();
  console.log(`OTel: telemetry initialized for ${serviceName} → ${endpoint}`);

  return {
    shutdown: () => sdk.shutdown(),
  };
}
