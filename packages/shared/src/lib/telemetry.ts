import { register } from 'node:module';
import {
  detectResources,
  envDetector,
  hostDetector,
  processDetector,
  type Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

type NodeSDKConfig = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;

export interface InitTelemetryOptions {
  serviceName: string;
  traceExporter?: NodeSDKConfig['traceExporter'];
  metricReader?: NodeSDKConfig['metricReader'];
  instrumentations?: NodeSDKConfig['instrumentations'];
  logRecordProcessors?: NodeSDKConfig['logRecordProcessors'];
  /**
   * Modules the instrumentations patch that the app reaches through ESM
   * `import` (`http`, `fastify`). Instrumentations patch through
   * `require-in-the-middle`, which never sees an ESM import; these names are
   * handed to the `import-in-the-middle` loader hook instead, and only these, so
   * the hook does not wrap every module in the process.
   */
  esmModules?: string[];
}

/**
 * Boots the OpenTelemetry SDK for a service. No-ops (and returns a no-op
 * shutdown) when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so dev environments
 * don't need any OTel infra wired up.
 *
 * Must run before the application's module graph is loaded: from a preload
 * passed to `node --import` (each service's `src/instrument.ts`), not from the
 * entry point's body. An ESM entry evaluates every static import before its
 * own first statement, so a call there runs after `http` and friends are
 * already bound and patches nothing.
 */
export function initTelemetry(opts: InitTelemetryOptions): {
  /** The resource every exported span carries; absent when telemetry is disabled. */
  resource?: Resource;
  shutdown: () => Promise<void>;
} {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!endpoint) {
    console.log(`OTel: no OTEL_EXPORTER_OTLP_ENDPOINT set, telemetry disabled`);
    return { shutdown: async () => {} };
  }

  // Built here, not left to NodeSDK, so spans that bypass a tracer (the worker's
  // workflow span) carry the very resource the SDK's own spans do. The merge
  // order is NodeSDK's: detected attributes (OTEL_SERVICE_NAME,
  // OTEL_RESOURCE_ATTRIBUTES, process, host) win over the defaults below.
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
  }).merge(detectResources({ detectors: [envDetector, processDetector, hostDetector] }));

  if (opts.esmModules?.length) {
    // DEP0205: Node 26 deprecates `register()` for `registerHooks()`, which
    // neither import-in-the-middle nor @opentelemetry/instrumentation offers
    // yet. The services' start scripts and Dockerfile CMDs pass
    // `--disable-warning=DEP0205` — only that code — until upstream moves; drop
    // the flags with this call.
    // Resolved against this file, which is why `@opentelemetry/instrumentation`
    // is a dependency of this package. Has to precede the app's imports, which
    // a `--import` preload guarantees.
    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
      data: { include: opts.esmModules },
    });
  }

  const sdk = new NodeSDK({
    autoDetectResources: false,
    instrumentations: opts.instrumentations ?? [],
    logRecordProcessors: opts.logRecordProcessors,
    metricReader: opts.metricReader,
    resource,
    traceExporter: opts.traceExporter,
  });

  sdk.start();
  console.log(`OTel: telemetry initialized for ${opts.serviceName} → ${endpoint}`);

  return {
    resource,
    shutdown: () => sdk.shutdown(),
  };
}
