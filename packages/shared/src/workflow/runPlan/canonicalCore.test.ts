import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NodeSchema, nodeEdges } from '../spec.js';
import { TICKET_TO_MERGE_SPEC } from '../templates/ticketToMerge.js';
import {
  buildCanonicalCore,
  CORE_ENTRY,
  CORE_GUIDANCE_SLOT,
  CORE_HOOK,
  canonicalCoreIds,
  stableJson,
} from './canonicalCore.js';
import { FREE_STATUS_ALLOWLIST, isTerminalStatusWord } from './skeletonBindings.js';

describe('buildCanonicalCore', () => {
  it('equals the corresponding nodes of the shipped ticket-to-merge template', () => {
    const core = buildCanonicalCore();
    const shipped = TICKET_TO_MERGE_SPEC.nodes;
    for (const [id, node] of Object.entries(core.nodes)) {
      expect(shipped[id], `template has '${id}'`).toBeDefined();
      const { use: _use, ...flat } = shipped[id] as Record<string, unknown>;
      // The canonical core is the template's node as the spec parser reads it (defaults applied).
      expect(stableJson(NodeSchema.parse(flat)), id).toBe(stableJson(node));
    }
  });

  it('leaves exactly the validate phase outside the core', () => {
    const core = new Set(canonicalCoreIds());
    const outside = Object.keys(TICKET_TO_MERGE_SPEC.nodes)
      .filter((id) => !core.has(id))
      .sort();
    expect(outside).toEqual(
      [
        'checkActionable',
        'gatherTicket',
        'setSuccessCriteria',
        'setTicket',
        'terminateNotActionable',
        'validate',
      ].sort()
    );
  });

  it('is closed: every edge of a core node stays in the core', () => {
    const { nodes } = buildCanonicalCore();
    for (const [id, node] of Object.entries(nodes)) {
      for (const [field, to] of nodeEdges(node)) {
        expect(Object.hasOwn(nodes, to), `${id}.${field} -> ${to}`).toBe(true);
      }
    }
  });

  it('names its entry, its hook and its guidance slot', () => {
    const core = buildCanonicalCore();
    expect(core.entry).toBe(CORE_ENTRY);
    expect(core.nodes[CORE_ENTRY]).toBeDefined();
    const wait = core.nodes[CORE_HOOK.node] as unknown as Record<string, unknown>;
    expect(wait[CORE_HOOK.field]).toBe(core.hookTarget);
    expect(core.nodes[core.hookTarget]).toBeDefined();
    const inputs = (core.nodes[CORE_GUIDANCE_SLOT.node] as { inputs: Record<string, unknown> })
      .inputs;
    expect(inputs[CORE_GUIDANCE_SLOT.key]).toBeUndefined();
  });

  it('never reads context.scratch or the plan notes', () => {
    const json = JSON.stringify(buildCanonicalCore().nodes);
    expect(json).not.toContain('context.scratch');
    expect(json).not.toContain('context.planNotes');
  });

  it('carries no macro tag and is a fresh object on every call', () => {
    const a = buildCanonicalCore();
    expect(JSON.stringify(a.nodes)).not.toContain('"use"');
    delete a.nodes.review;
    expect(buildCanonicalCore().nodes.review).toBeDefined();
  });
});

describe('the committed golden core', () => {
  // `equals the shipped template` above compares the builder with the template that is built from
  // it, so it cannot see a change to the shared builders. This file is a snapshot taken by hand.
  const golden = JSON.parse(
    readFileSync(new URL('./canonicalCore.golden.json', import.meta.url), 'utf8')
  ) as { entry: string; hookTarget: string; nodes: Record<string, unknown> };
  const MOVED =
    'the canonical core no longer matches canonicalCore.golden.json. Every generated plan is pinned to this core, so a change here changes what the policy admits. If the change is deliberate, regenerate the golden from buildCanonicalCore() (sorted keys, 2-space JSON), re-run the adversarial review of the skeleton policy, and commit both together.';

  it('has the same node ids, entry and hook as the golden', () => {
    const core = buildCanonicalCore();
    expect(Object.keys(core.nodes).sort(), MOVED).toEqual(Object.keys(golden.nodes).sort());
    expect(core.entry, MOVED).toBe(golden.entry);
    expect(core.hookTarget, MOVED).toBe(golden.hookTarget);
  });

  it.each(
    Object.keys(
      JSON.parse(readFileSync(new URL('./canonicalCore.golden.json', import.meta.url), 'utf8'))
        .nodes
    )
  )('has node %s as the golden has it', (id) => {
    const node = buildCanonicalCore().nodes[id];
    expect(node, MOVED).toBeDefined();
    expect(JSON.parse(stableJson(node)), MOVED).toEqual(golden.nodes[id]);
  });
});

describe('statuses', () => {
  const stamped = (): Set<string> =>
    new Set(
      Object.values(buildCanonicalCore().nodes).flatMap((n) =>
        n.type !== 'terminate' && n.status !== undefined ? [n.status] : []
      )
    );

  it('are stamped by the core on the words a free node may not use', () => {
    // The dashboard, review fixes and PR feedback read these; the core is what earns them.
    expect([...stamped()].sort()).toEqual([
      'AWAITING_CI',
      'AWAITING_HUMAN_MERGE',
      'IMPLEMENTING',
      'IN_REVIEW',
    ]);
  });

  it('share no word with what a free node may stamp, and none of it ends a run', () => {
    for (const word of FREE_STATUS_ALLOWLIST) {
      expect(stamped().has(word), word).toBe(false);
      expect(isTerminalStatusWord(word), word).toBe(false);
    }
  });
});
