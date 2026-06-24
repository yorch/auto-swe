import { describe, expect, it } from 'vitest';
import { scoreTrajectory, type TraceLike } from './trajectoryScorer.js';

const tool = (over: Partial<TraceLike> = {}): TraceLike => ({ type: 'tool_call', ...over });

describe('scoreTrajectory', () => {
  it('counts tool calls as steps and ignores llm/activity records', () => {
    const m = scoreTrajectory([
      tool({ toolName: 'readFile' }),
      tool({ toolName: 'bash' }),
      { type: 'llm_response' },
      { type: 'activity_event' },
    ]);
    expect(m.stepCount).toBe(2);
  });

  it('reports perfect correctness and no errors for an empty trajectory', () => {
    const m = scoreTrajectory([]);
    expect(m).toEqual({ guardrailHits: 0, stepCount: 0, toolCorrectness: 1, toolErrors: 0 });
  });

  it('computes the non-erroring tool-call ratio', () => {
    const m = scoreTrajectory([tool(), tool({ error: 'boom' }), tool(), tool()]);
    expect(m.toolErrors).toBe(1);
    expect(m.toolCorrectness).toBeCloseTo(0.75, 6);
  });

  it('counts guardrail hits from scanner error markers', () => {
    const m = scoreTrajectory([
      tool({ error: 'SENSITIVE_FILE: refused to write .env' }),
      tool({ error: 'SHELL_COMMAND_BLOCKED: curl ... | sh' }),
      tool({ error: 'some unrelated failure' }),
      tool(),
    ]);
    expect(m.guardrailHits).toBe(2);
    expect(m.toolErrors).toBe(3); // guardrail hits are also tool errors
  });
});
