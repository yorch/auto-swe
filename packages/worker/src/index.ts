import { initTelemetry } from './lib/telemetry.js';

// Initialize OTel BEFORE any other imports that need instrumentation
const otel = initTelemetry('auto-swe-worker');

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';
import { assertConfigReady } from './lib/config/assertReady.js';
import { initTemporalClient } from './lib/temporalClient.js';

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

  // Refuse to start if the DB doesn't have every required config row. The
  // dashboard at /admin/model-config is the bootstrap path — bring up the
  // gateway + web first, sign in as admin, add the rows, then start the
  // worker. If this throws the process exits non-zero so an orchestrator
  // (Docker Compose restart policy, K8s, etc.) keeps the worker out of the
  // rotation until config is complete.
  await assertConfigReady();

  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  await initTemporalClient();

  // Resolve workflow path relative to this file (ESM-compatible). Prefer
  // the TypeScript source so tsx-watch dev runs work; fall back to the
  // compiled .js for production (`node dist/index.js`).
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workflowsTs = path.resolve(__dirname, './workflows/index.ts');
  const workflowsJs = path.resolve(__dirname, './workflows/index.js');
  const workflowsPath = existsSync(workflowsTs) ? workflowsTs : workflowsJs;

  const worker = await Worker.create({
    activities,
    connection,
    // Most activities hold a Docker workspace (clone + container) — an
    // explicit cap keeps a burst of workflows from exhausting the Docker
    // host. The Temporal default (100) is far past what one host can serve.
    // Override with WORKER_MAX_CONCURRENT_ACTIVITIES.
    maxConcurrentActivityTaskExecutions: Number.parseInt(
      process.env.WORKER_MAX_CONCURRENT_ACTIVITIES ?? '10',
      10
    ),
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
