import { initTelemetry } from './lib/telemetry.js';

// Initialize OTel BEFORE any other imports that need instrumentation
const otel = initTelemetry('auto-swe-worker');

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEncryptionKeyConfigured } from '@auto-swe/shared/lib/crypto';
import { assertWorkspaceInfraEnv, resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { assertBuiltinStepsRegistered } from '@auto-swe/shared/workflow';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';
import { activitySpanInterceptor } from './lib/activitySpans.js';
import { assertConfigReady } from './lib/config/assertReady.js';
import { ignoredPriceOverrideVars } from './lib/costTracking.js';
import { initMetrics } from './lib/metrics.js';
import { initTemporalClient } from './lib/temporalClient.js';

async function run() {
  // Every provider credential and integration secret decrypts through this
  // key; without it the first LLM call fails inside an activity instead of
  // the process refusing to start. Check before anything else is initialised.
  assertEncryptionKeyConfigured();
  // After initTelemetry() above, so the instruments bind to the real provider.
  initMetrics();

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
  // dashboard at /studio/models is the bootstrap path — bring up the
  // gateway + web first, sign in as admin, add the rows, then start the
  // worker. If this throws the process exits non-zero so an orchestrator
  // (Docker Compose restart policy, K8s, etc.) keeps the worker out of the
  // rotation until config is complete.
  await assertConfigReady();

  // The resolvers fall back to defaults on a bad value (they run on paths that
  // must not throw), so a typo in the deploy environment would otherwise run
  // with different limits than the operator wrote. Fail the boot instead.
  assertWorkspaceInfraEnv();

  // MODEL_PRICE_* once overrode a model's price; the model catalog replaced it.
  // Name any still set, so a deployment that relied on one learns it is no
  // longer read instead of silently pricing at the catalog's rate.
  const ignoredPriceOverrides = ignoredPriceOverrideVars();
  if (ignoredPriceOverrides.length > 0) {
    console.warn(
      `Ignoring ${ignoredPriceOverrides.join(', ')}: per-model price overrides are no longer read. ` +
        'Set the price in the model catalog instead: PUT /api/v1/platform/model-catalog/<id> for a ' +
        'listed model, POST /api/v1/platform/model-catalog for one it lacks.'
    );
  }

  // Every step the worker promises in BUILTIN_STEPS must have registry
  // metadata, or validateSpec flags a shipped template as UNKNOWN_STEP and the
  // editor cannot render it. Cheap, synchronous, and better failed here than
  // discovered on the first template save.
  assertBuiltinStepsRegistered();

  // Temporal reads the concurrency cap when the worker is created, so it is an
  // environment variable (`WORKER_MAX_CONCURRENT_ACTIVITIES`): changing it means
  // a restart either way.
  const { maxConcurrentActivities } = resolveWorkspaceInfra();
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
    // One span + duration sample per activity attempt; see lib/activitySpans.ts.
    interceptors: { activity: [activitySpanInterceptor] },
    // Most activities hold a Docker workspace (clone + container) — an
    // explicit cap keeps a burst of workflows from exhausting the Docker
    // host. The Temporal default (100) is far past what one host can serve.
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
