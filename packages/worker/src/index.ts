import { initTelemetry } from './lib/telemetry.js';

// Initialize OTel BEFORE any other imports that need instrumentation
const otel = initTelemetry('auto-swe-worker');

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSetting } from '@auto-swe/shared/config';
import { assertEncryptionKeyConfigured } from '@auto-swe/shared/lib/crypto';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';
import { assertConfigReady } from './lib/config/assertReady.js';
import { initTemporalClient } from './lib/temporalClient.js';

async function run() {
  // Every provider credential and integration secret decrypts through this
  // key; without it the first LLM call fails inside an activity instead of
  // the process refusing to start. Check before anything else is initialised.
  assertEncryptionKeyConfigured();

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

  // Boot-time only: Temporal reads the concurrency cap when the worker is
  // created, so a change to it needs a restart — which is what the setting's
  // `restartRequired` flag tells an operator in the dashboard. Resolved
  // alongside the connection rather than before it; only `Worker.create` needs
  // both.
  const [maxConcurrentActivities, connection] = await Promise.all([
    resolveSetting('workspace.maxConcurrentActivities'),
    NativeConnection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    }),
  ]);
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
    // Read once at boot from the config registry (`workspace.maxConcurrentActivities`,
    // which still falls back to WORKER_MAX_CONCURRENT_ACTIVITIES), so the value
    // is visible in the dashboard rather than only in the process environment.
    maxConcurrentActivityTaskExecutions: maxConcurrentActivities,
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
