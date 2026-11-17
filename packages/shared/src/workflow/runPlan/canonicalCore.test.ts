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
