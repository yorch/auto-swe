import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import {
  COALESCE_MS,
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  recordEdit,
  redoStep,
  undoStep,
} from './specHistory';

const spec = (title = 'a', extra: string[] = []): WorkflowSpec => ({
  description: 'fixture',
  entry: 'start',
  name: 't',
  nodes: {
    done: { status: 'SUCCESS', type: 'terminate' },
    start: { command: title, image: 'alpine', next: 'done', type: 'shell' },
    ...Object.fromEntries(extra.map((id) => [id, { status: 'SUCCESS', type: 'terminate' }])),
  },
  schemaVersion: 1,
});

describe('spec history', () => {
  it('undoes and redoes through the recorded specs', () => {
    const a = spec('a');
    const b = spec('b', ['x']);
    const h = recordEdit(EMPTY_HISTORY, a, b, 0);
    const undone = undoStep(h, b);
    expect(undone?.spec).toBe(a);
    expect(undone?.history.past).toEqual([]);
    const redone = redoStep(undone?.history ?? EMPTY_HISTORY, a);
    expect(redone?.spec).toBe(b);
    expect(redone?.history.future).toEqual([]);
  });

  it('has nothing to undo or redo when empty', () => {
    expect(undoStep(EMPTY_HISTORY, spec())).toBeNull();
    expect(redoStep(EMPTY_HISTORY, spec())).toBeNull();
  });

  it('drops the redo branch on a new edit', () => {
    const a = spec('a');
    const b = spec('b', ['x']);
    const undone = undoStep(recordEdit(EMPTY_HISTORY, a, b, 0), b);
    const h = recordEdit(undone?.history ?? EMPTY_HISTORY, a, spec('c', ['y']), 10);
    expect(h.future).toEqual([]);
  });

  it('ignores an unchanged spec', () => {
    const a = spec();
    expect(recordEdit(EMPTY_HISTORY, a, a, 0)).toBe(EMPTY_HISTORY);
  });

  it('merges quick edits to the same node into one step, but not slow ones or structural ones', () => {
    const a = spec('a');
    const b = spec('ab');
    const c = spec('abc');
    const first = recordEdit(EMPTY_HISTORY, a, b, 100);
    const quick = recordEdit(first, b, c, 100 + COALESCE_MS - 1);
    expect(quick.past).toEqual([a]);
    const slow = recordEdit(first, b, c, 100 + COALESCE_MS);
    expect(slow.past).toEqual([a, b]);
    const structural = recordEdit(quick, c, spec('abc', ['x']), 200);
    expect(structural.past).toEqual([a, c]);
  });

  it('measures the merge window from the first edit of a run, so long typing is not one step', () => {
    const a = spec('a');
    const b = spec('ab');
    const c = spec('abc');
    const d = spec('abcd');
    const first = recordEdit(EMPTY_HISTORY, a, b, 0);
    const second = recordEdit(first, b, c, COALESCE_MS - 100);
    expect(second.past).toEqual([a]);
    const third = recordEdit(second, c, d, COALESCE_MS + 100);
    expect(third.past).toEqual([a, c]);
  });

  it('keeps a bounded number of steps', () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      h = recordEdit(h, spec('a', [`n${i}`]), spec('a', [`n${i + 1}`]), i * 10_000);
    }
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });
});
