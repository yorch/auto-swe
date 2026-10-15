import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  edgeFields,
  executorStepFor,
  INVENTORY_COMMAND,
  INVENTORY_DOC_PATH,
  NODE_FAMILIES,
  type NodeType,
  nodeTypes,
  renderWorkflowInventory,
  summarise,
  tableCell,
} from './inventory.js';
import { type Node, NodeSchema, nodeEdges, WorkflowSpecSchema } from './spec.js';
import { EXECUTOR_STEP_ALIASES, listAllSteps } from './stepRegistry.js';
import { BUILTIN_TEMPLATES } from './templates/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const RENDERED = renderWorkflowInventory();

/** The node-reference schema, by identity: `entry` is declared with it, as every edge field is. */
const NODE_ID_SCHEMA = WorkflowSpecSchema.shape.entry;

function unwrap(schema: z.ZodType): { inner: z.ZodType; optional: boolean } {
  let inner = schema;
  let optional = false;
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodDefault ||
    inner instanceof z.ZodNullable
  ) {
    optional ||= !(inner instanceof z.ZodNullable);
    inner = inner.unwrap() as z.ZodType;
  }
  return { inner, optional };
}

/**
 * An independent read of a node type's edges, from the schema alone: every field (at any depth,
 * through objects and arrays) whose schema is the node-reference schema.
 */
function schemaEdges(type: NodeType): string[] {
  const option = NodeSchema.options.find((o) => o.shape.type.value === type);
  const out: string[] = [];
  const walk = (schema: z.ZodType, at: string, optional: boolean): void => {
    const { inner, optional: opt } = unwrap(schema);
    if (inner === NODE_ID_SCHEMA) {
      out.push(`${at}${optional || opt ? '?' : ''}`);
    } else if (inner instanceof z.ZodArray) {
      walk(inner.element as z.ZodType, `${at}[]`, false);
    } else if (inner instanceof z.ZodObject) {
      for (const [key, field] of Object.entries(inner.shape as Record<string, z.ZodType>)) {
        walk(field, at ? `${at}.${key}` : key, false);
      }
    }
  };
  walk(option as unknown as z.ZodType, '', false);
  return out.sort();
}

describe('workflow inventory', () => {
  it('matches the committed docs/workflow-inventory.md', () => {
    const committed = readFileSync(path.join(ROOT, INVENTORY_DOC_PATH), 'utf8').replace(
      /\r\n/g,
      '\n'
    );
    expect(
      committed,
      `${INVENTORY_DOC_PATH} is out of date with the code — run \`${INVENTORY_COMMAND}\` and commit the result`
    ).toBe(RENDERED);
  });

  it('places every node type in exactly one family', () => {
    expect(Object.keys(NODE_FAMILIES).sort()).toEqual(nodeTypes().sort());
  });

  it('lists every node type, linked to its workflow-nodes.md section', () => {
    for (const type of nodeTypes()) {
      expect(RENDERED).toContain(`[\`${type}\`](./workflow-nodes.md#${type.toLowerCase()})`);
    }
  });

  it('lists every registered step, internal ones included', () => {
    const steps = listAllSteps();
    expect(steps.some((s) => s.internal)).toBe(true);
    for (const step of steps) {
      expect(RENDERED).toMatch(new RegExp(`^\\| \`${step.name}\`[ |]`, 'm'));
    }
  });

  it('lists every built-in template', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(RENDERED).toMatch(new RegExp(`^\\| \`${t.name}\`[ |]`, 'm'));
    }
  });

  it.each(nodeTypes())('reports exactly the edges of %s that the schema declares', (type) => {
    // Both directions: an edge nodeEdges walks that the schema does not declare as a node
    // reference, or a node reference in the schema that nodeEdges never walks, fails here.
    expect(edgeFields(type)).toEqual(schemaEdges(type));
  });

  it('agrees with nodeEdges on every node of every built-in template', () => {
    for (const t of BUILTIN_TEMPLATES) {
      for (const node of Object.values(t.spec.nodes) as Node[]) {
        const listed = edgeFields(node.type).map((f) => f.replace(/\?$/, ''));
        for (const [field] of nodeEdges(node)) {
          expect(listed, `${t.name}: ${node.type}.${field}`).toContain(
            field.replace(/\[\d+\]/g, '[]')
          );
        }
      }
    }
    expect(edgeFields('terminate')).toEqual([]);
    expect(edgeFields('humanDecision')).toEqual(['onTimeout', 'options[].next']);
    expect(edgeFields('step')).toEqual(['next?']);
  });

  it('maps each executor step back to the node type it backs', () => {
    for (const [step, type] of Object.entries(EXECUTOR_STEP_ALIASES)) {
      expect(executorStepFor(type as NodeType)).toBe(step);
    }
    expect(executorStepFor('cond')).toBeUndefined();
  });

  it('keeps table cells on one row and one column', () => {
    expect(tableCell('a | b\n  c <name>')).toBe('a \\| b c &lt;name&gt;');
    // Inside a code span `<` stays literal; `|` is still escaped, since GFM splits on it first.
    expect(tableCell('use `a<b>|c` here')).toBe('use `a<b>\\|c` here');
  });

  it('summarises a description to its first sentence', () => {
    expect(summarise('One thing. Another.')).toBe('One thing.');
    expect(summarise('Approve (e.g. sign-off) first. Then more.')).toBe(
      'Approve (e.g. sign-off) first.'
    );
    const long = summarise(`${'word '.repeat(60)}end.`);
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith('…')).toBe(true);
  });
});
