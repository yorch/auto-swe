import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';

async function run() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  // Resolve workflow path relative to this file (ESM-compatible)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workflowsPath = path.resolve(__dirname, './workflows/index.js');

  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'engineering-workflow',
    // Temporal bundles workflows separately (V8 isolate).
    // Only type-only imports are allowed in workflow files.
    workflowsPath,
    activities,
  });

  console.log('Worker started, polling task queue: engineering-workflow');
  await worker.run();
}

run().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
