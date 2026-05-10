import { initTelemetry } from './lib/telemetry.js';

// Initialize OTel BEFORE any other imports that need instrumentation
const otel = initTelemetry('auto-swe-worker');

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';

async function run() {
  // Install Temporal runtime with OTel metrics if endpoint is available
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otelEndpoint) {
    Runtime.install({
      telemetryOptions: {
        metrics: {
          otel: { headers: {}, url: otelEndpoint },
        },
      },
    });
  }

  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  // Resolve workflow path relative to this file (ESM-compatible)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workflowsPath = path.resolve(__dirname, './workflows/index.js');

  const worker = await Worker.create({
    activities,
    connection,
    namespace: 'default',
    taskQueue: 'engineering-workflow',
    // Temporal bundles workflows separately (V8 isolate).
    // Only type-only imports are allowed in workflow files.
    workflowsPath,
  });

  console.log('Worker started, polling task queue: engineering-workflow');
  await worker.run();
}

run().catch(async (err) => {
  console.error('Worker failed to start:', err);
  await otel.shutdown();
  process.exit(1);
});
