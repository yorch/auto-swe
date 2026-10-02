import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { collapsibleGroups } from './foldGroups';
import { nodeDisplayName, nodeGroupOf } from './nodeDisplay';
import { buildOutline } from './outline';
import { specToFlow } from './specToFlow';

/**
 * A stored or bundle-installed spec can carry a `title`/`group` in any shape. Reading
 * degrades the bad value to absent, and every view must show what is left safely.
 */
const BAD = parseWorkflowSpec({
  entry: 'a',
  name: 't',
  nodes: {
    a: { group: 'ci ', next: 'b', step: 'x', title: 't'.repeat(500), type: 'step' },
    b: { group: ' ci', next: 'c', step: 'x', title: { en: 'x' }, type: 'step' },
    c: { group: 42, next: 'end', step: 'x', title: '', type: 'step' },
    end: { group: '', status: 'SUCCESS', type: 'terminate' },
  },
  schemaVersion: 1,
});

describe('views over a spec with malformed group/title values', () => {
  it('names every node by its id and groups only by the valid, trimmed label', () => {
    for (const id of ['a', 'b', 'c', 'end']) {
      expect(nodeDisplayName(BAD.nodes[id], id)).toBe(id);
    }
    expect(nodeGroupOf(BAD.nodes.a)).toBe('ci');
    expect(nodeGroupOf(BAD.nodes.b)).toBe('ci');
    expect(nodeGroupOf(BAD.nodes.c)).toBeUndefined();
  });

  it('draws the graph and builds the outline, with "ci" and "ci " as one group', () => {
    expect(specToFlow(BAD).nodes).toHaveLength(4);
    expect(buildOutline(BAD).map((s) => s.group)).toEqual(['ci', null, null]);
    expect(collapsibleGroups(BAD)).toEqual(['ci']);
  });
});
