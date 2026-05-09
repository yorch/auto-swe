import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * Initializes OpenTelemetry for the gateway service.
 * Must be called BEFORE Fastify is created so auto-instrumentation can patch.
 * No-ops gracefully when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
 */
export function initTelemetry(serviceName: string): { shutdown: () => Promise<void> } {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!endpoint) {
    console.log(`OTel: no OTEL_EXPORTER_OTLP_ENDPOINT set, telemetry disabled`);
    return { shutdown: async () => {} };
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}` }),
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
    ],
  });

  sdk.start();
  console.log(`OTel: telemetry initialized for ${serviceName} → ${endpoint}`);

  return {
    shutdown: () => sdk.shutdown(),
  };
}
