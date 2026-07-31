/**
 * Determinism guard for `RunnableWorkflow`.
 *
 * `runnable.workflow.test.ts` runs the workflow forward against fake activities,
 * which catches logic errors. It cannot catch the failure mode Temporal is
 * hardest to debug: a change that makes the workflow take a *different path*
 * when replaying an execution that already happened. In production that surfaces
 * as a stuck workflow long after the deploy that caused it.
 *
 * This replays a recorded history against the current workflow code. A
 * non-deterministic change — reordering activity calls, adding one on a path
 * that already ran, branching on `Date.now()`/`Math.random()`, iterating an
 * unordered collection — makes the replay diverge and fails the test.
 *
 * **When this fails, re-recording the fixture is almost never the fix.** Do that
 * only when the workflow's structure changed intentionally; see
 * `scripts/recordReplayHistory.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import proto from '@temporalio/proto';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { beforeAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = path.resolve(__dirname, './index.ts');
const FIXTURE = path.resolve(__dirname, './__fixtures__/runnable-history.bin');

// Binary protobuf, not JSON: the proto3-JSON converters mangle Timestamps and
// Payload metadata on round-trip, so the wire format is the honest fixture.
const history = proto.temporal.api.history.v1.History.decode(readFileSync(FIXTURE));

beforeAll(() => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
});

describe('RunnableWorkflow — history replay', () => {
  it('replays a recorded execution without a determinism violation', async () => {
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history)
    ).resolves.toBeUndefined();
  }, 120_000);

  it('has real workflow-task history to replay', () => {
    // A truncated fixture would make the replay above pass vacuously.
    const types = (history.events ?? []).map((e) => e.eventType);
    expect(types.length).toBeGreaterThan(10);
    expect(types).toContain(
      proto.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED
    );
    expect(types).toContain(
      proto.temporal.api.enums.v1.EventType.EVENT_TYPE_ACTIVITY_TASK_COMPLETED
    );
    expect(
      types.filter(
        (t) => t === proto.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED
      ).length
    ).toBeGreaterThan(1);
  });
});
