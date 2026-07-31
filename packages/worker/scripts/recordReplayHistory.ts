/**
 * Records a `RunnableWorkflow` execution history to a JSON fixture, which
 * `runnable.replay.test.ts` then replays against current workflow code.
 *
 * Run this **only** when the recorded history is genuinely stale — i.e. the
 * workflow's own structure changed intentionally. Regenerating it to make a
 * failing replay test pass defeats the entire point of the test: a determinism
 * violation is exactly what it is meant to catch.
 *
 *   yarn workspace @auto-swe/worker exec tsx scripts/recordReplayHistory.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import proto from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = path.resolve(__dirname, '../src/workflows/index.ts');
const OUT = path.resolve(__dirname, '../src/workflows/__fixtures__/runnable-history.bin');

/**
 * Exercises the paths most likely to break determinism: a dispatched step, a
 * conditional branch on its output, and an explicit terminate. A trivial
 * set→terminate spec would replay cleanly no matter how badly the interpreter
 * were rewritten.
 */
const SPEC = {
  description: 'Replay fixture — do not edit by hand.',
  entry: 'implement',
  name: 'replay-fixture-spec',
  nodes: {
    check: {
      expr: '$.nodes.implement.output.ok',
      onFalse: 'failed',
      onTrue: 'done',
      type: 'cond',
    },
    done: { result: { value: 'ok' }, status: 'SUCCESS', type: 'terminate' },
    failed: { status: 'FAILED', type: 'terminate' },
    implement: { next: 'check', step: 'executeImplementation', type: 'step' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};

const activities = {
  cancelPendingHumanSteps: async () => {},
  createHumanStep: async () => {},
  createWorkflowRun: async () => ({ runId: 'replay-fixture-run', spec: SPEC }),
  executeImplementation: async () => ({ ok: true, summary: 'fixture' }),
  finalizeWorkflowRun: async () => {},
  recordWorkflowStep: async () => {},
  resolveHumanStep: async () => {},
  updateDomainState: async () => {},
};

async function main(): Promise<void> {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const taskQueue = 'replay-history-recorder';
    const worker = await Worker.create({
      activities,
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: WORKFLOWS_PATH,
    });

    // Everything must happen inside runUntil: the worker stops as soon as the
    // promise settles, and `start()` settles the moment the workflow is queued —
    // leaving nothing to poll it to completion.
    const history = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start('RunnableWorkflow', {
        args: [
          {
            request: {
              budgetTier: 'STANDARD',
              description: 'replay fixture',
              externalTicketId: 'REPLAY-1',
              repoId: '00000000-0000-4000-8000-000000000001',
              requestPayload: '{}',
              workRequestId: '00000000-0000-4000-8000-000000000002',
            },
            templateId: 'tpl-replay',
            templateVersion: 1,
          },
        ],
        taskQueue,
        workflowExecutionTimeout: '2 hours',
        workflowId: 'replay-fixture',
      });
      await handle.result().catch(() => undefined);
      return handle.fetchHistory();
    });
    mkdirSync(path.dirname(OUT), { recursive: true });
    // Binary protobuf rather than JSON. The proto3-JSON converters round-trip
    // Timestamps and Payload metadata badly in both directions; the wire format
    // is exact and is what the replayer consumes anyway.
    writeFileSync(OUT, proto.temporal.api.history.v1.History.encode(history).finish());
    console.log(`Wrote ${OUT} (${history.events?.length ?? 0} events)`);
  } finally {
    await env.teardown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
