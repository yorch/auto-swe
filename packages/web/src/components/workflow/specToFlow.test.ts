import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { buildDagOverlay } from '@/lib/dagOverlay';
import { foldedGroupId, foldGroups } from './foldGroups';
import { hasDisplayTitle, nodeDisplayName, nodeGroupOf } from './nodeDisplay';
import { buildOutline, outlineIds } from './outline';
import { specToFlow } from './specToFlow';

const spec = (nodes: Record<string, unknown>, entry: string) =>
  parseWorkflowSpec({ entry, name: 't', nodes, schemaVersion: 1 });

describe('nodeDisplay', () => {
  const titled = spec(
    {
      a: { group: ' build ', next: 'end', step: 'x', title: '  Build it  ', type: 'step' },
      b: { next: 'end', step: 'x', title: '   ', type: 'step' },
      end: { status: 'SUCCESS', type: 'terminate' },
    },
    'a'
  );

  it('names a node by its title, and falls back to its id', () => {
    expect(nodeDisplayName(titled.nodes.a, 'a')).toBe('Build it');
    expect(hasDisplayTitle(titled.nodes.a, 'a')).toBe(true);
    // A blank title is no title.
    expect(nodeDisplayName(titled.nodes.b, 'b')).toBe('b');
    expect(nodeDisplayName(titled.nodes.end, 'end')).toBe('end');
    expect(hasDisplayTitle(titled.nodes.end, 'end')).toBe(false);
    expect(nodeDisplayName(undefined, 'gone')).toBe('gone');
  });

  it('reads the group, trimmed, and treats blank as none', () => {
    expect(nodeGroupOf(titled.nodes.a)).toBe('build');
    expect(nodeGroupOf(titled.nodes.end)).toBeUndefined();
  });

  it('names a human node by its inbox title', () => {
    const s = spec(
      {
        ask: {
          onApprove: 'end',
          onReject: 'end',
          onTimeout: 'end',
          timeout: '1h',
          title: 'Approve the change',
          type: 'humanApproval',
        },
        end: { status: 'SUCCESS', type: 'terminate' },
      },
      'ask'
    );
    expect(nodeDisplayName(s.nodes.ask, 'ask')).toBe('Approve the change');
  });
});

describe('specToFlow with titles and groups', () => {
  const s = spec(
    {
      a: {
        group: 'build',
        next: 'b',
        step: 'executeImplementation',
        title: 'Implement',
        type: 'step',
      },
      b: { group: 'build', next: 'end', step: 'runLint', type: 'step' },
      end: { status: 'SUCCESS', type: 'terminate' },
    },
    'a'
  );

  it('announces a titled node by its title and id, and its group', () => {
    const { nodes } = specToFlow(s);
    const a = nodes.find((n) => n.id === 'a');
    expect(a?.ariaLabel).toContain('step node Implement (a)');
    expect(a?.ariaLabel).toContain('group build');
    // An untitled node is announced by its id, as before.
    expect(nodes.find((n) => n.id === 'end')?.ariaLabel).toBe('terminate node end, → SUCCESS');
  });

  it('keeps the node itself on the card data, so the card can show the title', () => {
    const { nodes } = specToFlow(s);
    expect(nodes.find((n) => n.id === 'a')?.data.node).toMatchObject({ title: 'Implement' });
  });

  it('draws a collapsed group as one card whose edges and handles line up', () => {
    const fold = foldGroups(s, new Set(['build']));
    const { nodes, edges } = specToFlow(fold.spec, {
      extraEdges: fold.extraEdges,
      folded: fold.folded,
      statuses: { byNodeId: { a: { attempt: 1, status: 'PASSED' } } },
    });
    const card = nodes.find((n) => n.id === foldedGroupId('build'));
    expect(card?.data.folded).toMatchObject({ group: 'build', ran: 1 });
    expect(card?.ariaLabel).toBe('build group, 2 steps, collapsed, 1 ran, press Enter to expand');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: foldedGroupId('build'), target: 'end' });
    // The edge leaves through a handle the card actually draws.
    expect(card?.data.folded?.exits.map((e) => e.port)).toContain(edges[0]?.sourceHandle);
  });
});

describe('a spec stored before group/title existed', () => {
  const goldenDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../shared/src/workflow/templates/__golden__'
  );
  const files = readdirSync(goldenDir).filter((f) => f.endsWith('.json'));

  it('has the golden fixtures to test against', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  // The run viewer parses `run.specSnapshot` with the current schema and swallows a failure
  // to "no graph", so a snapshot that stopped parsing would blank every historical run page.
  it.each(files)('%s: parses, lays out as a graph and outlines, with no group anywhere', (file) => {
    const raw = JSON.parse(readFileSync(path.join(goldenDir, file), 'utf8'));
    const parsed = parseWorkflowSpec(raw);
    const ids = Object.keys(parsed.nodes);

    const { nodes, edges } = specToFlow(parsed);
    expect(nodes.map((n) => n.id).sort()).toEqual([...ids].sort());
    expect(edges.length).toBeGreaterThan(0);
    // Every card reads as it always did: by id.
    for (const n of nodes) {
      const node = parsed.nodes[n.id];
      if (node && !node.type.startsWith('human')) {
        expect(nodeDisplayName(node, n.id)).toBe(n.id);
      }
      expect(nodeGroupOf(node)).toBeUndefined();
    }

    // The outline lists every step once, as plain ungrouped rows.
    const sections = buildOutline(parsed);
    expect(sections.every((sec) => sec.group === null)).toBe(true);
    expect(outlineIds(sections).sort()).toEqual([...ids].sort());

    // And a run's overlay still paints onto it.
    const overlay = buildDagOverlay([{ attempt: 1, nodeId: ids[0] as string, status: 'PASSED' }]);
    expect(specToFlow(parsed, { statuses: overlay }).nodes[0]?.data.status).toBeDefined();
  });
});
