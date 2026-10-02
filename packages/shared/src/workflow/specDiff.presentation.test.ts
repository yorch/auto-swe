import { describe, expect, it } from 'vitest';
import type { WorkflowSpec } from './spec.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import { diffSpecs, specsEqual } from './specDiff.js';

function spec(nodes?: Record<string, unknown>): WorkflowSpec {
  return {
    description: '',
    entry: 'start',
    name: 'test',
    nodes: (nodes ?? {
      done: { status: 'SUCCESS', type: 'terminate' },
      start: { next: 'done', step: 'executeImplementation', type: 'step' },
    }) as WorkflowSpec['nodes'],
    schemaVersion: SPEC_SCHEMA_VERSION,
  };
}

const START = { next: 'done', step: 'executeImplementation', type: 'step' };
const DONE = { status: 'SUCCESS', type: 'terminate' };

describe('diffSpecs and presentation-only fields', () => {
  it('reports a group/title-only change separately, not as a changed node', () => {
    const d = diffSpecs(
      spec(),
      spec({ done: DONE, start: { ...START, group: 'build', title: 'Start' } })
    );
    expect(d.changedNodes).toEqual([]);
    expect(d.presentationOnlyNodes).toEqual(['start']);
    expect(d.unchangedNodes).toEqual(['done']);
    // Not "equal": something differs, though nothing structural does.
    expect(specsEqual(spec(), spec({ done: DONE, start: { ...START, group: 'g' } }))).toBe(false);
  });

  it('still reports a real change on a node that also gained a group', () => {
    const d = diffSpecs(
      spec(),
      spec({ done: DONE, start: { ...START, group: 'build', step: 'runLint' } })
    );
    expect(d.changedNodes).toEqual(['start']);
    expect(d.presentationOnlyNodes).toEqual([]);
  });

  it('keeps a real removal visible when every other node only gained a group', () => {
    const before = spec({
      done: DONE,
      gone: { next: 'done', step: 'x', type: 'step' },
      start: START,
    });
    const after = spec({
      done: { ...DONE, group: 'g' },
      start: { ...START, group: 'g', title: 'T' },
    });
    const d = diffSpecs(before, after);
    expect(d.removedNodes).toEqual(['gone']);
    expect(d.changedNodes).toEqual([]);
    expect(d.presentationOnlyNodes).toEqual(['done', 'start']);
  });

  it('treats a human node title as content, not presentation', () => {
    const human = (title: string) =>
      spec({
        ask: {
          onApprove: 'done',
          onReject: 'done',
          onTimeout: 'done',
          timeout: '1h',
          title,
          type: 'humanApproval',
        },
        done: DONE,
        start: START,
      });
    const d = diffSpecs(human('A'), human('B'));
    expect(d.changedNodes).toEqual(['ask']);
    expect(d.presentationOnlyNodes).toEqual([]);
  });

  it('is quiet when the presentation fields are identical', () => {
    const s = () => spec({ done: DONE, start: { ...START, group: 'g' } });
    const d = diffSpecs(s(), s());
    expect(d.presentationOnlyNodes).toEqual([]);
    expect(d.changedNodes).toEqual([]);
    expect(specsEqual(s(), s())).toBe(true);
  });
});
