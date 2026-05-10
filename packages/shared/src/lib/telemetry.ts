import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

type NodeSDKConfig = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;

export interface InitTelemetryOptions {
  serviceName: string;
  traceExporter?: NodeSDKConfig['traceExporter'];
  metricReader?: NodeSDKConfig['metricReader'];
  instrumentations?: NodeSDKConfig['instrumentations'];
}

/**
 * Boots the OpenTelemetry SDK for a service. No-ops (and returns a no-op
 * shutdown) when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so dev environments
 * don't need any OTel infra wired up.
 *
 * Must be invoked BEFORE the application code being instrumented is
 * constructed (auto-instrumentation needs to patch modules at import time).
 */
export function initTelemetry(opts: InitTelemetryOptions): { shutdown: () => Promise<void> } {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!endpoint) {
    console.log(`OTel: no OTEL_EXPORTER_OTLP_ENDPOINT set, telemetry disabled`);
    return { shutdown: async () => {} };
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
  });

  const sdk = new NodeSDK({
    instrumentations: opts.instrumentations ?? [],
    metricReader: opts.metricReader,
    resource,
    traceExporter: opts.traceExporter,
  });

  sdk.start();
  console.log(`OTel: telemetry initialized for ${opts.serviceName} → ${endpoint}`);

  return {
    shutdown: () => sdk.shutdown(),
  };
}
