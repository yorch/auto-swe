import { describe, expect, it } from 'vitest';
import type { Context } from '../workflow/expr.js';
import { type Dispatcher, runSpec } from '../workflow/interpreter.js';
import { parseWorkflowSpec } from '../workflow/spec.js';
import { CHANNEL_TASK_SPEC } from './syncBuiltins.js';

interface Call {
  step: string;
  inputs: Record<string, unknown>;
}

/**
 * Minimal dispatcher: `planChannelTask` returns the supplied plan; `task` (the
 * single-agent node, dispatched as `runAgentNode`) echoes the request; and
 * `runChannelSubtasks` (the composite step) folds its subtasks into one answer.
 */
function makeDispatcher(planResult: unknown): { dispatcher: Dispatcher; calls: Call[] } {
  const calls: Call[] = [];
  const dispatcher: Dispatcher = {
    async dispatchStep({ step, inputs }) {
      calls.push({ inputs, step });
      if (step === 'planChannelTask') {
        return planResult;
      }
      if (step === 'runAgentNode') {
        return { text: `ANSWER(${String(inputs.task)})` };
      }
      if (step === 'runChannelSubtasks') {
        const subs = (inputs.subtasks as Array<{ description: string }>) ?? [];
        return { text: `SYNTH(${subs.map((s) => s.description).join('|')})` };
      }
      throw new Error(`unexpected step ${step}`);
    },
    async recordStep() {},
    async waitSignal() {
      return undefined;
    },
  };
  return { calls, dispatcher };
}

const baseCtx = (): Context => ({
  context: {},
  nodes: {},
  request: { description: 'Do the thing', externalTicketId: 'CHAN-1', repoId: 'n/a' },
  workflow: { id: 'chan-test-1' },
});

describe('CHANNEL_TASK_SPEC — general-route decomposition', () => {
  it('parses and validates', () => {
    expect(() => parseWorkflowSpec(CHANNEL_TASK_SPEC)).not.toThrow();
  });

  it('wires plan → cond → {single agent | composite step}', () => {
    const { nodes } = CHANNEL_TASK_SPEC;
    expect(nodes.plan.type).toBe('step');
    expect((nodes.plan as { step: string }).step).toBe('planChannelTask');

    expect(nodes.decide.type).toBe('cond');
    expect((nodes.decide as { onFalse: string; onTrue: string }).onFalse).toBe('task');
    expect((nodes.decide as { onTrue: string }).onTrue).toBe('composite');

    expect(nodes.task.type).toBe('agent');
    expect(nodes.composite.type).toBe('step');
    expect((nodes.composite as { step: string }).step).toBe('runChannelSubtasks');
  });

  it('takes the single-agent path when the planner returns one subtask', async () => {
    const { dispatcher, calls } = makeDispatcher({
      subtaskCount: 1,
      subtasks: [{ description: 'Do the thing', title: 'Task' }],
    });
    const result = await runSpec(parseWorkflowSpec(CHANNEL_TASK_SPEC), baseCtx(), dispatcher);

    expect(result.status).toBe('SUCCESS');
    expect(result.result.result).toBe('ANSWER(Do the thing)');
    // Single path: plan + the task agent node, and NO composite step.
    expect(calls.map((c) => c.step)).toEqual(['planChannelTask', 'runAgentNode']);
    // finalize reads nodes.task.output.text on this path.
    const nodes = result.finalContext.nodes as Record<string, { output?: { text?: string } }>;
    expect(nodes.task?.output?.text).toBe('ANSWER(Do the thing)');
    expect(nodes.composite).toBeUndefined();
  });

  it('takes the composite path when the planner splits, passing the subtasks through', async () => {
    const subtasks = [
      { description: 'part A', title: 'A' },
      { description: 'part B', title: 'B' },
      { description: 'part C', title: 'C' },
    ];
    const { dispatcher, calls } = makeDispatcher({ subtaskCount: 3, subtasks });
    const result = await runSpec(parseWorkflowSpec(CHANNEL_TASK_SPEC), baseCtx(), dispatcher);

    expect(result.status).toBe('SUCCESS');
    // Decompose path: plan + composite step, NO single-agent node.
    expect(calls.map((c) => c.step)).toEqual(['planChannelTask', 'runChannelSubtasks']);
    // The composite step received the planner's subtasks + the original task.
    const composite = calls.find((c) => c.step === 'runChannelSubtasks');
    expect(composite?.inputs.subtasks).toEqual(subtasks);
    expect(composite?.inputs.task).toBe('Do the thing');
    // finalize reads nodes.composite.output.text on this path.
    const nodes = result.finalContext.nodes as Record<string, { output?: { text?: string } }>;
    expect(nodes.composite?.output?.text).toBe('SYNTH(part A|part B|part C)');
    expect(result.result.result).toBe(nodes.composite?.output?.text);
    expect(nodes.task).toBeUndefined();
  });
});
