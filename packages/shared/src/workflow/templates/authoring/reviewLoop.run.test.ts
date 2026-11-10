import { describe, expect, it } from 'vitest';
import type { Context } from '../../expr.js';
import { type Dispatcher, runSpec } from '../../interpreter.js';
import { type Node, SPEC_SCHEMA_VERSION, WorkflowSpecSchema } from '../../spec.js';
import { reviewLoop } from './reviewLoop.js';

/**
 * Runs the real loop under the interpreter. The fake review stands in for the activity's stall
 * decision: it reports `stalled` when a rejection repeats the `previousFingerprint` it was given.
 */
async function run(
  fingerprints: (string | null)[],
  opts: { exhausted?: string; reenterOnce?: boolean } = {}
) {
  const { reenterOnce, ...loopOpts } = opts;
  const nodes: Record<string, Node> = {
    ...(reviewLoop({ approved: reenterOnce ? 'ciGate' : 'done', ...loopOpts }) as Record<
      string,
      Node
    >),
    // What ticket-to-merge does after an approval: CI fails once, a fix goes back into the review.
    ciFix: { next: 'review', type: 'set', values: { 'context.ci': { literal: 1 } } },
    ciGate: { expr: 'context.ci == 0', onFalse: 'done', onTrue: 'ciFix', type: 'cond' },
    done: { status: 'SUCCESS', type: 'terminate' },
    init: {
      next: 'review',
      type: 'set',
      values: {
        'context.ci': { literal: 0 },
        'context.currentCodeResult': { literal: { filesChanged: [] } },
      },
    },
    lessonFailed: { result: { via: { literal: 'lesson' } }, status: 'FAILED', type: 'terminate' },
  };
  const spec = WorkflowSpecSchema.parse({
    description: '',
    entry: 'init',
    name: 'review-loop-run',
    nodes,
    schemaVersion: SPEC_SCHEMA_VERSION,
  });
  const reviewInputs: Record<string, unknown>[] = [];
  let fixes = 0;
  const dispatcher: Dispatcher = {
    async dispatchStep({ step, inputs }) {
      if (step === 'runReviewNetwork') {
        const fingerprint =
          fingerprints[reviewInputs.length] === undefined
            ? `unseen-${reviewInputs.length}`
            : fingerprints[reviewInputs.length];
        const previous = inputs.previousFingerprint;
        reviewInputs.push(inputs);
        if (fingerprint === null) {
          return { approved: true, verdicts: [] };
        }
        return {
          approved: false,
          rejectionFingerprint: fingerprint,
          rejectionSummary: 'nope',
          stalled: fingerprint === previous ? true : undefined,
          verdicts: [],
        };
      }
      if (step === 'executeReviewFixImplementation') {
        fixes += 1;
        return { filesChanged: [] };
      }
      return {};
    },
    async recordStep() {},
    async waitSignal() {
      return undefined;
    },
  };
  const ctx: Context = {
    context: {},
    nodes: {},
    request: { description: 'x', externalTicketId: 'T-1', repoId: 'r-1' },
    workflow: { id: 'eng-t-1' },
  };
  const result = await runSpec(spec, ctx, dispatcher);
  return { fixes, result, reviewInputs };
}

describe('reviewLoop under the interpreter', () => {
  it('fails after the second review when it rejects for the same findings, having fixed once', async () => {
    const { fixes, result, reviewInputs } = await run(['a|X|f.ts', 'a|X|f.ts']);
    expect(result.status).toBe('FAILED');
    expect(reviewInputs).toHaveLength(2);
    expect(fixes).toBe(1);
    expect(reviewInputs[0].previousFingerprint).toBe('');
    expect(reviewInputs[1].previousFingerprint).toBe('a|X|f.ts');
  });

  it('runs on to the attempt limit while the findings keep changing', async () => {
    const { fixes, result, reviewInputs } = await run(['a', 'b', 'c', 'd']);
    expect(result.status).toBe('FAILED');
    expect(reviewInputs).toHaveLength(3);
    expect(fixes).toBe(2);
  });

  it('sends a stall to `exhausted`, as running out of attempts does', async () => {
    const stalled = await run(['a', 'a'], { exhausted: 'lessonFailed' });
    expect(stalled.result.status).toBe('FAILED');
    expect(stalled.result.result).toMatchObject({ via: 'lesson' });
    expect(stalled.fixes).toBe(1);
  });

  it('does not stall a rejection that repeats one from before an approval', async () => {
    const { fixes, result, reviewInputs } = await run(['a|X|f.ts', null, 'a|X|f.ts', null], {
      reenterOnce: true,
    });
    expect(result.status).toBe('SUCCESS');
    expect(reviewInputs).toHaveLength(4);
    expect(fixes).toBe(2);
    expect(reviewInputs.map((i) => i.previousFingerprint)).toEqual([
      '',
      'a|X|f.ts',
      '',
      'a|X|f.ts',
    ]);
  });
});
