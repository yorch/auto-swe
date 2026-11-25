/**
 * Determinism guard for `CampaignReconcilerWorkflow`: each committed history is replayed against
 * current workflow code, and a change that makes the workflow take a different path on replay
 * fails it. One fixture per control-flow shape (spec §14): reconcile to completion, a gate that
 * holds a target BLOCKED, a pause and resume, a wake by a pull-request signal, a regression, and
 * `continueAsNew`.
 *
 * A reconciler runs for weeks, so one is always in flight across a deploy. A change to its
 * scheduling goes behind `patched('campaign-…')`; the fixtures stay as they are. They live in
 * their own directory so the replay suites of the other workflows, which read every `.bin` beside
 * them, never see them.
 *
 * **When this fails, re-recording the fixture is almost never the fix** — see
 * `scripts/recordCampaignReconcilerHistory.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import proto from '@temporalio/proto';
import {
  bundleWorkflowCode,
  DefaultLogger,
  Runtime,
  Worker,
  type WorkflowBundleWithSourceMap,
} from '@temporalio/worker';
import { beforeAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = path.resolve(__dirname, './index.ts');
const FIXTURE_DIR = path.resolve(__dirname, './__fixtures__/campaign-reconciler');

const EventType = proto.temporal.api.enums.v1.EventType;

/** The workflow id `scripts/recordCampaignReconcilerHistory.ts` starts each fixture's run under. */
const replayWorkflowId = (name: string) => `replay-fixture-${name}`;

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
  });

const eventsOf = (name: string) => fixtures.find((f) => f.name === name)?.history.events ?? [];
const typesOf = (name: string) => eventsOf(name).map((e) => e.eventType);
const activitiesOf = (name: string) =>
  eventsOf(name)
    .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
    .filter((n): n is string => Boolean(n));
const count = (name: string, type: proto.temporal.api.enums.v1.EventType) =>
  typesOf(name).filter((t) => t === type).length;
const signalsOf = (name: string) =>
  eventsOf(name)
    .map((e) => e.workflowExecutionSignaledEventAttributes?.signalName)
    .filter((n): n is string => Boolean(n));

// One bundle for every replay: the same code `workflowsPath` would compile, built once.
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  const logger = new DefaultLogger('WARN');
  Runtime.install({ logger });
  workflowBundle = await bundleWorkflowCode({ logger, workflowsPath: WORKFLOWS_PATH });
}, 600_000);

describe('CampaignReconcilerWorkflow — history replay', () => {
  it('has a fixture for every control-flow shape worth guarding', () => {
    expect(fixtures.map((f) => [f.name, f.type])).toEqual(
      [
        'cancel-workflow',
        'cancel',
        'check-failed',
        'complete',
        'continue-as-new',
        'discovery',
        'gate-blocked',
        'pause-resume',
        'planning-confirm',
        'pull-request-signal',
        'refusal-pause',
        'regression',
      ].map((name) => [name, 'CampaignReconcilerWorkflow'])
    );
  });

  it.each(fixtures)(
    'replays $name without a determinism violation',
    async ({ history, name }) => {
      await expect(
        Worker.runReplayHistory({ workflowBundle }, history, replayWorkflowId(name))
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
    expect(types.at(-1)).toBeOneOf([
      EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED,
      EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW,
      EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED,
    ]);
  });

  describe('what each fixture guards', () => {
    it('complete reads, starts in order and finalizes as completed', () => {
      const acts = activitiesOf('complete');
      expect(acts.slice(0, 2)).toEqual(['updateDomainState', 'readCampaignPass']);
      expect(acts.filter((a) => a === 'startCampaignAttempt')).toHaveLength(3);
      expect(acts).toContain('finalizeCampaignReconciler');
      expect(acts.at(-1)).toBe('updateDomainState');
      expect(typesOf('complete').at(-1)).toBe(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED);
    });

    it('gate-blocked held a target back, woke on the pull-request signal and re-checked', () => {
      expect(signalsOf('gate-blocked')).toContain('campaignPullRequestChanged');
      const acts = activitiesOf('gate-blocked');
      expect(acts).toContain('runCampaignCheck');
      expect(acts.filter((a) => a === 'startCampaignAttempt')).toHaveLength(2);
      // The block was recorded before the second start.
      expect(acts.filter((a) => a === 'recordCampaignPass').length).toBeGreaterThanOrEqual(2);
    });

    it('pause-resume was woken by the control signals and the attempt-finished signal', () => {
      const signals = signalsOf('pause-resume');
      expect(signals.filter((s) => s === 'campaignControl')).toHaveLength(2);
      expect(signals).toContain('campaignAttemptFinished');
      expect(activitiesOf('pause-resume').filter((a) => a === 'startCampaignAttempt')).toHaveLength(
        2
      );
    });

    it('pull-request-signal slept on a timer until the webhook signal woke it', () => {
      expect(
        count('pull-request-signal', EventType.EVENT_TYPE_TIMER_STARTED)
      ).toBeGreaterThanOrEqual(1);
      expect(signalsOf('pull-request-signal')).toEqual(['campaignPullRequestChanged']);
      expect(activitiesOf('pull-request-signal')).toContain('runCampaignCheck');
      expect(activitiesOf('pull-request-signal')).not.toContain('startCampaignAttempt');
    });

    it('regression re-checked a satisfied target, then started it again', () => {
      const acts = activitiesOf('regression');
      const check = acts.indexOf('runCampaignCheck');
      const start = acts.indexOf('startCampaignAttempt');
      expect(check).toBeGreaterThan(-1);
      expect(start).toBeGreaterThan(check);
    });

    it('cancel closed the rows when the campaign said CANCELLING, and ended completed', () => {
      const acts = activitiesOf('cancel');
      expect(acts.filter((a) => a === 'startCampaignAttempt')).toHaveLength(1);
      expect(signalsOf('cancel')).toEqual(['campaignControl']);
      // Attempts are cancelled before the rows are finalized, then the domain state is written.
      const cancel = acts.indexOf('cancelCampaignAttempts');
      expect(cancel).toBeGreaterThan(-1);
      expect(acts.indexOf('finalizeCampaignReconciler')).toBeGreaterThan(cancel);
      expect(typesOf('cancel').at(-1)).toBe(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED);
    });

    it('cancel-workflow closed the rows when the workflow itself was cancelled', () => {
      const acts = activitiesOf('cancel-workflow');
      expect(acts).toContain('cancelCampaignAttempts');
      expect(acts).toContain('finalizeCampaignReconciler');
      expect(typesOf('cancel-workflow').at(-1)).toBe(
        EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED
      );
    });

    it('planning-confirm planned once, started nothing until the confirm, then ran both targets', () => {
      const acts = activitiesOf('planning-confirm');
      expect(acts.filter((a) => a === 'planCampaignBriefs')).toHaveLength(1);
      expect(signalsOf('planning-confirm')).toContain('campaignControl');
      const firstStart = acts.indexOf('startCampaignAttempt');
      expect(acts.indexOf('planCampaignBriefs')).toBeLessThan(firstStart);
      expect(acts.filter((a) => a === 'startCampaignAttempt')).toHaveLength(2);
      expect(acts).toContain('finalizeCampaignReconciler');
    });

    it('discovery walked the scope in chunks and wrote a chunk before reading the next', () => {
      const acts = activitiesOf('discovery');
      expect(acts.filter((a) => a === 'discoverCampaignTargets')).toHaveLength(2);
      // A write for the first chunk's findings sits between the two walks of the scope.
      const first = acts.indexOf('discoverCampaignTargets');
      const second = acts.lastIndexOf('discoverCampaignTargets');
      expect(acts.slice(first, second)).toContain('recordCampaignPass');
      expect(acts.filter((a) => a === 'startCampaignAttempt')).toHaveLength(1);
    });

    it('refusal-pause paused on the gateway’s refusal and went on after a resume', () => {
      const acts = activitiesOf('refusal-pause');
      // The refused start, the pause write, then the start that succeeded after the resume.
      expect(acts.filter((a) => a === 'startCampaignAttempt')).toHaveLength(2);
      expect(acts).toContain('recordCampaignPass');
      expect(signalsOf('refusal-pause')).toEqual(['campaignControl', 'campaignAttemptFinished']);
    });

    it('check-failed ran the check once, kept the campaign open and ended when a person skipped it', () => {
      const acts = activitiesOf('check-failed');
      expect(acts.filter((a) => a === 'runCampaignCheck')).toHaveLength(1);
      expect(acts).not.toContain('startCampaignAttempt');
      expect(signalsOf('check-failed')).toEqual(['campaignControl']);
      expect(acts.at(-1)).toBe('updateDomainState');
    });

    it('continue-as-new polled through 200 passes before it continued', () => {
      expect(activitiesOf('continue-as-new').filter((a) => a === 'readCampaignPass')).toHaveLength(
        200
      );
      expect(typesOf('continue-as-new').at(-1)).toBe(
        EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW
      );
      const continued =
        eventsOf('continue-as-new').at(-1)?.workflowExecutionContinuedAsNewEventAttributes;
      const input = JSON.parse(
        Buffer.from(continued?.input?.payloads?.[0]?.data ?? []).toString()
      ) as Record<string, unknown>;
      // The counters the next execution starts from.
      expect(input).toMatchObject({ campaignId: expect.any(String), passes: 200 });
      expect(input.lastDiscoveryAt).toEqual(expect.any(Number));
      expect(input.lastBackstopAt).toEqual(expect.any(Number));
    });
  });
});
