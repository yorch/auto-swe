/**
 * Determinism guard for the workflows that are not `RunnableWorkflow`: the epic
 * orchestrator and the channel assistant family. The sibling of
 * `runnable.replay.test.ts`, with the same contract — each committed history is
 * replayed against current workflow code, and a change that makes the workflow
 * take a different path on replay fails it.
 *
 * These matter as much as the interpreter's: an epic runs for as long as its
 * slowest child, and a deferred channel task sleeps until its `runAt`, so both
 * are routinely in flight across a deploy. The epic orchestrator is already
 * carrying two `patched()` gates (`epic-event-driven-scheduling`,
 * `epic-cancel-children`); a third change made without one is what this catches.
 *
 * Only the parent's history is guarded here. The `RunnableWorkflow` children an
 * epic or a channel task starts are covered by `runnable.replay.test.ts`.
 *
 * **When this fails, re-recording the fixture is almost never the fix** — see
 * `scripts/recordReplayHistory.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import proto from '@temporalio/proto';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { beforeAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = path.resolve(__dirname, './index.ts');
const FIXTURE_DIR = path.resolve(__dirname, './__fixtures__');

const EventType = proto.temporal.api.enums.v1.EventType;

/** The workflow id `scripts/recordReplayHistory.ts` starts each fixture's run under. */
const replayWorkflowId = (name: string) => `replay-fixture-${name}`;

/** Discovered, like the RunnableWorkflow fixtures, and keyed by workflow type. */
const fixtures = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.bin'))
  .sort()
  .map((file) => {
    const history = proto.temporal.api.history.v1.History.decode(
      readFileSync(path.join(FIXTURE_DIR, file))
    );
    return {
      history,
      name: path.basename(file, '.bin'),
      type: history.events?.[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name,
    };
  })
  .filter((f) => f.type !== 'RunnableWorkflow');

const eventsOf = (name: string) => fixtures.find((f) => f.name === name)?.history.events ?? [];
const typesOf = (name: string) => eventsOf(name).map((e) => e.eventType);
const activitiesOf = (name: string) =>
  eventsOf(name)
    .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
    .filter(Boolean);
const patchesOf = (name: string) =>
  eventsOf(name)
    .filter((e) => e.eventType === EventType.EVENT_TYPE_MARKER_RECORDED)
    .map((e) => {
      const payload = e.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0];
      return payload?.data ? (JSON.parse(Buffer.from(payload.data).toString()).id as string) : '';
    });
const count = (name: string, type: proto.temporal.api.enums.v1.EventType) =>
  typesOf(name).filter((t) => t === type).length;

beforeAll(() => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
});

describe('Epic and channel workflows — history replay', () => {
  it('has a fixture for every control-flow shape worth guarding', () => {
    // Named with their type: silently losing one, or recording one against
    // the wrong workflow, would quietly narrow the guard.
    expect(fixtures.map((f) => [f.name, f.type])).toEqual([
      ['channel-ambient', 'ChannelAmbientWorkflow'],
      ['channel-assistant-delegate', 'ChannelAssistantWorkflow'],
      ['channel-assistant-error', 'ChannelAssistantWorkflow'],
      ['channel-assistant-followup-skip', 'ChannelAssistantWorkflow'],
      ['channel-assistant-generate', 'ChannelAssistantWorkflow'],
      ['channel-assistant-refine', 'ChannelAssistantWorkflow'],
      ['channel-assistant-reply', 'ChannelAssistantWorkflow'],
      ['channel-reactive', 'ChannelReactiveWorkflow'],
      ['channel-scheduled-task', 'ChannelScheduledTaskWorkflow'],
      ['epic-cancel', 'EpicOrchestratorWorkflow'],
      ['epic-dag', 'EpicOrchestratorWorkflow'],
      ['epic-planned', 'EpicOrchestratorWorkflow'],
    ]);
  });

  it.each(fixtures)(
    'replays $name without a determinism violation',
    async ({ history, name }) => {
      // Replayed under the id it was recorded with: a workflow that derives a
      // child's id from its own (the deferred-task wrapper's `<id>-run`) would
      // otherwise diverge on the id alone.
      await expect(
        Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, replayWorkflowId(name))
      ).resolves.toBeUndefined();
    },
    120_000
  );

  it.each(fixtures)('$name fixture carries real workflow-task history', ({ history }) => {
    // A truncated fixture would make its replay pass vacuously.
    const types = (history.events ?? []).map((e) => e.eventType);
    expect(types.length).toBeGreaterThan(10);
    expect(types).toContain(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED);
    expect(
      types.filter((t) => t === EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED).length
    ).toBeGreaterThan(1);
    // Every fixture ran to a close, so replay walks the whole run, not a prefix.
    expect(types.at(-1)).toBeOneOf([
      EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED,
      EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED,
    ]);
  });

  describe('EpicOrchestratorWorkflow', () => {
    it('epic-dag took the event-driven path and skipped the failed repo’s dependent', () => {
      // Recorded under the patch, so replay guards the event-driven scheduler,
      // not the wave scheduler kept for older histories.
      expect(patchesOf('epic-dag')).toEqual(['epic-event-driven-scheduling']);
      // a, b and c ran; d sits behind the failed b and never started.
      const children = eventsOf('epic-dag')
        .map((e) => e.startChildWorkflowExecutionInitiatedEventAttributes?.workflowId)
        .filter(Boolean);
      expect(children).toEqual([
        'replay-fixture-epic-dag-a',
        'replay-fixture-epic-dag-b',
        'replay-fixture-epic-dag-c',
      ]);
      expect(activitiesOf('epic-dag')).not.toContain('planEpic');
    });

    it('epic-planned asked the planner before fanning out', () => {
      expect(activitiesOf('epic-planned').slice(0, 3)).toEqual([
        'updateDomainState',
        'planEpic',
        'updateDomainState',
      ]);
      expect(
        count('epic-planned', EventType.EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED)
      ).toBe(2);
    });

    it('epic-cancel cancelled the in-flight children', () => {
      expect(patchesOf('epic-cancel')).toEqual([
        'epic-event-driven-scheduling',
        'epic-cancel-children',
      ]);
      expect(typesOf('epic-cancel')).toContain(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED);
      // x and y were parked; z, behind x, never started.
      expect(
        count('epic-cancel', EventType.EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED)
      ).toBe(2);
      expect(
        count(
          'epic-cancel',
          EventType.EVENT_TYPE_REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED
        )
      ).toBe(2);
      expect(count('epic-cancel', EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_CANCELED)).toBe(2);
    });
  });

  describe('channel workflows', () => {
    it('each assistant fixture walked the branch it is named for', () => {
      // The turn's outcome picks the branch; a fixture whose fake turn drifted
      // would replay the plain-reply path under another name.
      expect(activitiesOf('channel-assistant-reply')).toEqual([
        'startChannelRun',
        'postChannelPlaceholder',
        'runChannelAssistantTurn',
        'updateChannelReply',
        'touchChannelThreadSession',
        'finalizeChannelRun',
      ]);
      expect(activitiesOf('channel-assistant-followup-skip')).toEqual([
        'startChannelRun',
        'runChannelAssistantTurn',
        'touchChannelThreadSession',
        'finalizeChannelRun',
      ]);
      expect(activitiesOf('channel-assistant-error')).toEqual([
        'startChannelRun',
        'postChannelPlaceholder',
        'runChannelAssistantTurn',
        'updateChannelReply',
        'finalizeChannelRun',
      ]);
      expect(activitiesOf('channel-assistant-generate')).toContain('createChannelWorkflowDraft');
      expect(activitiesOf('channel-assistant-refine')).toContain('refineChannelWorkflowDraft');
    });

    it('channel-assistant-delegate started the thread-bound task child', () => {
      const started = eventsOf('channel-assistant-delegate')
        .map((e) => e.startChildWorkflowExecutionInitiatedEventAttributes)
        .filter(Boolean);
      expect(started.map((a) => a?.workflowType?.name)).toEqual(['RunnableWorkflow']);
      expect(activitiesOf('channel-assistant-delegate')).toContain('createChannelTaskRun');
    });

    it('channel-scheduled-task slept, launched, and forwarded a steer to the run', () => {
      const types = typesOf('channel-scheduled-task');
      // Steered before the timer fired (folded) and after the child started
      // (forwarded), so both halves of the steer handler are on the record.
      const firstSteer = types.indexOf(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED);
      const fired = types.indexOf(EventType.EVENT_TYPE_TIMER_FIRED);
      const childStarted = types.indexOf(EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED);
      const lastSteer = types.lastIndexOf(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED);
      expect(firstSteer).toBeGreaterThan(-1);
      expect(firstSteer).toBeLessThan(fired);
      expect(fired).toBeLessThan(childStarted);
      expect(childStarted).toBeLessThan(lastSteer);
      expect(types).toContain(EventType.EVENT_TYPE_EXTERNAL_WORKFLOW_EXECUTION_SIGNALED);
      expect(types).toContain(EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_COMPLETED);
    });

    it('channel-ambient ran every pass even though the digest failed', () => {
      expect(activitiesOf('channel-ambient')).toEqual([
        'startChannelRun',
        'runChannelAmbientDigest',
        'consolidateChannelMemory',
        'sweepChannelOpenItems',
        'passiveIngestChannelMemory',
        'flagOrgSignals',
        'finalizeChannelRun',
      ]);
      expect(typesOf('channel-ambient')).toContain(EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED);
    });

    it('channel-reactive ran its interjection check', () => {
      expect(activitiesOf('channel-reactive')).toEqual([
        'startChannelRun',
        'evaluateReactiveInterjection',
        'finalizeChannelRun',
      ]);
    });
  });
});
