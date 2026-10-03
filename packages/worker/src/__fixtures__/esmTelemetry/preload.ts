// `--import` preload for instrument.test.ts: the shared init path, with an
// in-memory exporter in place of OTLP. ESM_MODULES='' leaves the hook off.
import { initTelemetry } from '@auto-swe/shared/lib/telemetry';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

const exporter = new InMemorySpanExporter();
(globalThis as { __spanExporter?: InMemorySpanExporter }).__spanExporter = exporter;

initTelemetry({
  esmModules: process.env.ESM_MODULES ? process.env.ESM_MODULES.split(',') : undefined,
  instrumentations: [new HttpInstrumentation()],
  serviceName: 'esm-telemetry-fixture',
  traceExporter: exporter,
});
