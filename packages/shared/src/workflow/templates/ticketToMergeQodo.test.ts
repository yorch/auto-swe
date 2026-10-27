import { describe, expect, it } from 'vitest';
import type { Context } from '../expr.js';
import { type Dispatcher, runSpec } from '../interpreter.js';
import { parseWorkflowSpec } from '../spec.js';
import { validateSpec } from '../validateSpec.js';
import { TICKET_TO_MERGE_SPEC, ticketToMergeNodes } from './ticketToMerge.js';
import { TICKET_TO_MERGE_QODO_SPEC } from './ticketToMergeQodo.js';

const nodes = TICKET_TO_MERGE_QODO_SPEC.nodes as Record<string, Record<string, unknown>>;

describe('ticket-to-merge-qodo', () => {
  it('parses and validates', () => {
    expect(() => parseWorkflowSpec(TICKET_TO_MERGE_QODO_SPEC)).not.toThrow();
    expect(validateSpec(TICKET_TO_MERGE_QODO_SPEC, { allowInternalSteps: true }).errors).toEqual(
      []
    );
  });

  it('is named for what it adds and says what an unconfigured Qodo costs', () => {
    expect(TICKET_TO_MERGE_QODO_SPEC.name).toBe('ticket-to-merge-qodo');
    expect(TICKET_TO_MERGE_QODO_SPEC.description).toMatch(/Qodo/);
    expect(TICKET_TO_MERGE_QODO_SPEC.description).toMatch(/qodo\.enabled/);
  });

  it('hands off to Qodo when CI passes, not to the merge wait', () => {
    expect(nodes.checkCI?.onTrue).toBe('qodoReview');
    expect(TICKET_TO_MERGE_SPEC.nodes.checkCI).toMatchObject({ onTrue: 'setAwaitingHumanMerge' });
  });

  it('reads the final head and the pull request the run opened', () => {
    expect(nodes.qodoReview).toMatchObject({
      inputs: {
        headSha: { from: 'context.currentCodeResult.headSha' },
        prUrl: { from: 'context.prUrl' },
      },
      next: 'qodoGate',
      step: 'awaitQodoReview',
    });
  });

  it('sends a blocking review to a person and every other result to the merge wait', () => {
    expect(nodes.qodoGate).toMatchObject({
      expr: 'nodes.qodoReview.output.blocking == true',
      onFalse: 'setAwaitingHumanMerge',
      onTrue: 'qodoDecision',
    });
  });

  it('lets the person continue to the merge wait or stop, and times out on no answer', () => {
    const decision = nodes.qodoDecision as {
      onTimeout: string;
      options: Array<{ next: string; value: string }>;
      storeAs: string;
      type: string;
    };
    expect(decision.type).toBe('humanDecision');
    expect(decision.options.map((o) => [o.value, o.next])).toEqual([
      ['continue', 'setAwaitingHumanMerge'],
      ['stop', 'terminateQodoStopped'],
    ]);
    expect(decision.onTimeout).toBe('terminateQodoTimedOut');
    expect(nodes.terminateQodoStopped).toMatchObject({ status: 'FAILED', type: 'terminate' });
    expect(nodes.terminateQodoTimedOut).toMatchObject({ status: 'TIMED_OUT', type: 'terminate' });
  });

  it('keeps every other node of ticket-to-merge as it is', () => {
    const base = ticketToMergeNodes('qodoReview');
    for (const [id, node] of Object.entries(TICKET_TO_MERGE_SPEC.nodes)) {
      if (id === 'checkCI') {
        continue;
      }
      expect(nodes[id], id).toEqual(node);
    }
    expect(Object.keys(nodes).sort()).toEqual(
      [
        ...Object.keys(base),
        'qodoGate',
        'qodoReview',
        'qodoDecision',
        'terminateQodoStopped',
        'terminateQodoTimedOut',
      ].sort()
    );
  });
});

/**
 * Runs the template from the Qodo step to its end, against fake step results. The graph before it
 * (implement, review, CI) belongs to ticket-to-merge; what is new is what Qodo's result decides.
 */
describe('ticket-to-merge-qodo, from the Qodo step to the end of the run', () => {
  const HEAD = 'f'.repeat(40);
  const PR_URL = 'https://github.com/acme/api/pull/9';
  const tail = { ...TICKET_TO_MERGE_QODO_SPEC, entry: 'qodoReview' };

  const ctx = (): Context => ({
    context: {
      currentCodeResult: { branch: 'auto/T-1', headSha: HEAD },
      prNumber: 9,
      prUrl: PR_URL,
    },
    nodes: {},
    request: { externalTicketId: 'T-1', repoId: 'r-1' },
    workflow: { id: 'eng-t-1' },
  });

  function run(opts: {
    /** Output of `awaitQodoReview`, or an error to throw. */
    qodo: unknown | Error;
    /** Payload for the human decision; undefined is a timeout. */
    decision?: { value: string };
  }) {
    const steps: Array<{ step: string; inputs: Record<string, unknown> }> = [];
    const signals: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatchStep({ inputs, step }) {
        steps.push({ inputs, step });
        if (step === 'awaitQodoReview') {
          if (opts.qodo instanceof Error) {
            throw opts.qodo;
          }
          return opts.qodo;
        }
        return {};
      },
      async recordStep() {},
      async waitSignal(name) {
        signals.push(name);
        return name === 'hitl_qodoDecision' ? opts.decision : {};
      },
    };
    return runSpec(parseWorkflowSpec(tail), ctx(), dispatcher).then((result) => ({
      result,
      signals,
      steps,
    }));
  }

  const reviewed = (over: Record<string, unknown> = {}) => ({
    blocking: false,
    status: 'reviewed',
    ...over,
  });

  it('reads the final head commit and the pull request the run opened', async () => {
    const { steps } = await run({ qodo: reviewed() });
    expect(steps.find((s) => s.step === 'awaitQodoReview')?.inputs).toEqual({
      headSha: HEAD,
      prUrl: PR_URL,
    });
  });

  it.each([
    ['a review with nothing blocking', reviewed()],
    ['a review that is still pending', { blocking: false, status: 'pending' }],
    ['a review of another commit', { blocking: false, status: 'stale' }],
    ['Qodo unavailable', { blocking: false, status: 'unavailable' }],
    ['Qodo switched off', { blocking: false, status: 'disabled' }],
    ['a step that failed (null output)', new Error('the activity failed')],
  ])('goes on to the merge wait without asking anyone for %s', async (_name, qodo) => {
    const { result, signals } = await run({ qodo });
    expect(result.status).toBe('SUCCESS');
    expect(signals).toEqual(['humanMergeSignal']);
  });

  it('asks a person when the review is blocking, and goes on when they continue', async () => {
    const { result, signals } = await run({
      decision: { value: 'continue' },
      qodo: reviewed({ blocking: true }),
    });
    expect(signals).toEqual(['hitl_qodoDecision', 'humanMergeSignal']);
    expect(result.status).toBe('SUCCESS');
  });

  it('ends the run FAILED, before the merge wait, when the person stops it', async () => {
    const { result, signals } = await run({
      decision: { value: 'stop' },
      qodo: reviewed({ blocking: true }),
    });
    expect(signals).toEqual(['hitl_qodoDecision']);
    expect(result.status).toBe('FAILED');
    expect(result.result).toMatchObject({ prNumber: 9, prUrl: PR_URL });
  });

  it('ends the run TIMED_OUT, before the merge wait, when nobody answers', async () => {
    const { result, signals } = await run({ qodo: reviewed({ blocking: true }) });
    expect(signals).toEqual(['hitl_qodoDecision']);
    expect(result.status).toBe('TIMED_OUT');
  });
});
