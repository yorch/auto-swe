import { initTelemetry } from './lib/telemetry.js';

// Initialize OTel BEFORE any other imports that need instrumentation
const otel = initTelemetry('auto-swe-worker');

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';
import { seedConfigFromEnv } from './lib/config/seed.js';

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

  // Bootstrap LLM model + credential configuration from env vars into the DB.
  // Idempotent and concurrent-worker-safe; failures are logged but non-fatal
  // (the resolver's env fallback keeps activities running until the DB is reachable).
  try {
    const seedResult = await seedConfigFromEnv();
    if (seedResult.rolesSeeded > 0 || seedResult.credentialsSeeded > 0) {
      console.log(
        `[config] seeded ${seedResult.rolesSeeded} model role(s) and ${seedResult.credentialsSeeded} provider credential(s) from env`
      );
    }
  } catch (err) {
    console.error('[config] env→DB seed failed (non-fatal, resolver will use env fallback):', err);
  }

  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

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
