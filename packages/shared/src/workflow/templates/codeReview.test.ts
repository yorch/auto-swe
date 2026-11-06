import { describe, expect, it } from 'vitest';
import { type Dispatcher, runSpec } from '../interpreter.js';
import type { WorkflowSpec } from '../spec.js';
import { CODE_REVIEW_SPEC } from './codeReview.js';
import { CODE_REVIEW_QODO_SPEC } from './codeReviewQodo.js';
import { HUMAN_REVIEW_OF_RUN_SPEC } from './humanReviewOfRun.js';
import { BUILTIN_TEMPLATES } from './index.js';

async function execute(spec: WorkflowSpec, mode: string, decision = 'approve', prompt?: string) {
  const calls: Array<{ step: string; inputs: Record<string, unknown> }> = [];
  const dispatcher: Dispatcher = {
    async dispatchStep({ step, inputs }) {
      calls.push({ inputs, step });
      if (step === 'loadChangeForReview') {
        return { diff: 'source diff', headSha: 'head', prUrl: 'https://host/pr/7' };
      }
      if (step === 'runReviewNetwork') {
        return { approved: true, verdicts: [] };
      }
      if (step === 'awaitQodoReview') {
        return { blocking: true };
      }
      return { approved: true };
    },
    async recordStep() {},
    async waitSignal(name) {
      if (decision === 'timeout') {
        return undefined;
      }
      return name.includes('decision') ? { value: decision } : { feedback: 'Human note' };
    },
  };
  const result = await runSpec(
    spec,
    {
      context: {},
      nodes: {},
      request: { payload: { reviewOf: { mode }, ...(prompt ? { systemPrompt: prompt } : {}) } },
      workflow: { id: 'review-test' },
    },
    dispatcher
  );
  return { calls, result };
}

describe('review templates', () => {
  it('seeds only the three review templates as review kind', () => {
    expect(
      BUILTIN_TEMPLATES.filter((t) => t.kind === 'review')
        .map((t) => t.name)
        .sort()
    ).toEqual(['code-review', 'code-review-qodo', 'human-review-of-run']);
  });

  it.each([undefined, 'Preset instructions'])(
    'forwards the optional preset prompt (%s)',
    async (prompt) => {
      const { calls } = await execute(CODE_REVIEW_SPEC, 'branch', 'approve', prompt);
      expect(calls.map((c) => c.step)).toEqual([
        'loadChangeForReview',
        'runReviewNetwork',
        'publishReviewResult',
      ]);
      expect(calls[1].inputs.systemPrompt).toBe(prompt ?? '');
      expect(calls[1].inputs.codeResult).toMatchObject({ diff: 'source diff' });
    }
  );

  it.each(['pr', 'branch', 'stored'])('runs Qodo only for PR mode (%s)', async (mode) => {
    const { calls } = await execute(CODE_REVIEW_QODO_SPEC, mode);
    expect(calls.some((c) => c.step === 'awaitQodoReview')).toBe(mode === 'pr');
    expect(calls.at(-1)?.inputs.qodo).toEqual(mode === 'pr' ? { blocking: true } : undefined);
  });

  it.each(['approve', 'request-changes'])(
    'publishes the human decision and note (%s)',
    async (decision) => {
      const { calls, result } = await execute(HUMAN_REVIEW_OF_RUN_SPEC, 'stored', decision);
      expect(result.status).toBe('SUCCESS');
      expect(calls.at(-1)).toEqual({
        inputs: { human: { decision, feedback: 'Human note' } },
        step: 'publishReviewResult',
      });
      expect(calls.some((c) => c.step === 'runReviewNetwork')).toBe(false);
    }
  );

  it('does not publish an approval on human timeout', async () => {
    const { calls, result } = await execute(HUMAN_REVIEW_OF_RUN_SPEC, 'stored', 'timeout');
    expect(result.status).toBe('TIMED_OUT');
    expect(calls.map((c) => c.step)).toEqual(['loadChangeForReview']);
  });
});
