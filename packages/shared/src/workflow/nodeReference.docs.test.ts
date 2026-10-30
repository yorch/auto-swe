import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isShellImageAllowed } from './shellImageAllowlist.js';
import { type Node, NodeSchema, nodeEdges, parseWorkflowSpec, type WorkflowSpec } from './spec.js';
import { BUILTIN_TEMPLATES } from './templates/index.js';
import { validateSpec } from './validateSpec.js';

/**
 * `docs/workflow-nodes.md` is the hand-written reference for every node type. Prose has no
 * compiler, so this test is one: it holds the page to the schema, the validator and the
 * built-in templates, and fails when a node type, a field, an edge or an example drifts.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_PATH = path.resolve(HERE, '../../../../docs/workflow-nodes.md');
const DOC = readFileSync(DOC_PATH, 'utf8');

/** The order the reference documents the node types in. */
const DOC_ORDER = [
  'step',
  'agent',
  'mcp',
  'shell',
  'containerStep',
  'eval',
  'set',
  'cond',
  'fanOut',
  'terminate',
  'signal',
  'humanApproval',
  'humanDecision',
  'humanInput',
  'humanReview',
] as const;

/** Fields documented once, in §5, rather than in every node's table. */
const COMMON_FIELDS = [
  'group',
  'title',
  'next',
  'onFail',
  'onError',
  'retry',
  'startToCloseTimeout',
  'heartbeatTimeout',
];

const LABELS = [
  '**Purpose.**',
  '**Fields.**',
  '**Edges.**',
  '**Output.**',
  '**Failure.**',
  '**Built-in examples.**',
  '**Example.**',
  '**Pitfalls.**',
  '**See also.**',
];

const NONE_BUILT_IN = 'None of the built-in templates uses this node.';

/** What §5's "On" column means by "dispatch nodes" (§4 defines the term). */
const DISPATCH_TYPES = ['step', 'agent', 'mcp', 'shell', 'containerStep', 'eval'];

const SCHEMA_KEYS = new Map<string, string[]>(
  NodeSchema.options.map((o) => [o.shape.type.value as string, Object.keys(o.shape)] as const)
);

/** Per node type, whether each schema field may be left out (optional or defaulted). */
const SCHEMA_OPTIONAL = new Map<string, Map<string, boolean>>(
  NodeSchema.options.map(
    (o) =>
      [
        o.shape.type.value as string,
        new Map(
          Object.entries(o.shape).map(([k, v]) => [
            k,
            (v as { isOptional(): boolean }).isOptional(),
          ])
        ),
      ] as const
  )
);
const SPEC_TYPES = [...SCHEMA_KEYS.keys()];

/** The text between a `## ` heading starting with `prefix` and the next `## ` heading. */
function chapter(prefix: string): string {
  const start = DOC.indexOf(`\n## ${prefix}`);
  if (start < 0) {
    throw new Error(`no "## ${prefix}" heading in docs/workflow-nodes.md`);
  }
  const end = DOC.indexOf('\n## ', start + 1);
  return DOC.slice(start, end < 0 ? undefined : end);
}

const NODE_CHAPTER = chapter('6. Node reference');
const HEADING_RE = /^### `([A-Za-z]+)`$/gm;
const HEADINGS = [...NODE_CHAPTER.matchAll(HEADING_RE)].map((m) => m[1] as string);

/** Each node type's section of §6, keyed by type. */
const SECTIONS = new Map<string, string>(
  [...NODE_CHAPTER.matchAll(HEADING_RE)].map((m, i, all) => {
    const next = all[i + 1];
    return [m[1] as string, NODE_CHAPTER.slice(m.index, next ? next.index : undefined)] as const;
  })
);

/** The data rows of the first markdown table after `label`, as trimmed cells. */
function tableAfter(text: string, label: string): string[][] {
  const start = text.indexOf(label);
  expect(start, label).toBeGreaterThanOrEqual(0);
  const lines = text.slice(start + label.length).split('\n');
  const first = lines.findIndex((l) => l.startsWith('|'));
  const rows: string[][] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith('|')) {
      break;
    }
    rows.push(
      line
        .slice(1, -1)
        .split(' | ')
        .map((c) => c.trim())
    );
  }
  // Drop the header row and the |---| separator.
  return rows.filter((cells) => cells[0] !== 'Field' && !/^[-|: ]+$/.test(cells[0] ?? ''));
}

/** The backticked names in a table cell: "`memory`, `cpus`" → ["memory", "cpus"]. */
function codeNames(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

function jsonBlocks(text: string): string[] {
  return [...text.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map((m) => m[1] as string);
}

function section(type: string): string {
  const text = SECTIONS.get(type);
  if (text === undefined) {
    throw new Error(`no "### \`${type}\`" section in docs/workflow-nodes.md`);
  }
  return text;
}

function exampleOf(type: string): WorkflowSpec {
  const [block] = jsonBlocks(section(type));
  return parseWorkflowSpec(JSON.parse(block as string));
}

function nodesOfType(spec: WorkflowSpec, type: string): Node[] {
  return Object.values(spec.nodes).filter((n) => n.type === type);
}

/** The paragraph after a bold label, up to the next blank line. */
function paragraphAfter(text: string, label: string): string {
  const start = text.indexOf(label);
  expect(start, label).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + label.length);
  const end = rest.indexOf('\n\n');
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

describe('docs/workflow-nodes.md', () => {
  it('documents the same set of node types the schema defines', () => {
    expect([...DOC_ORDER].sort()).toEqual([...SPEC_TYPES].sort());
  });

  it('has one "### `<type>`" heading per node type, in reference order', () => {
    expect(HEADINGS).toEqual([...DOC_ORDER]);
  });

  it('documents every common field in §5', () => {
    const common = chapter('5. Common fields');
    const present = new Set([...SCHEMA_KEYS.values()].flat());
    for (const field of COMMON_FIELDS) {
      expect(present.has(field), `${field} is a real node field`).toBe(true);
      expect(common, `\`${field}\` in §5`).toContain(`\`${field}\``);
    }
  });

  it('§5 lists, for each common field, exactly the node types whose schema has it', () => {
    const rows = tableAfter(
      chapter('5. Common fields'),
      'the per-type tables in §6 list the rest.'
    );
    const seen = new Set<string>();
    for (const [fieldCell = '', onCell = ''] of rows) {
      const on =
        onCell === 'every node'
          ? SPEC_TYPES
          : onCell === 'dispatch nodes'
            ? DISPATCH_TYPES
            : codeNames(onCell);
      for (const field of codeNames(fieldCell)) {
        seen.add(field);
        const actual = SPEC_TYPES.filter((t) => SCHEMA_KEYS.get(t)?.includes(field));
        expect([...on].sort(), `§5 "On" for \`${field}\``).toEqual(actual.sort());
      }
    }
    expect([...seen].sort()).toEqual([...COMMON_FIELDS].sort());
  });

  it('parses and validates every JSON example with no errors or warnings', () => {
    const blocks = jsonBlocks(DOC);
    expect(blocks.length).toBeGreaterThanOrEqual(DOC_ORDER.length);
    for (const block of blocks) {
      const spec = parseWorkflowSpec(JSON.parse(block));
      const report = validateSpec(spec);
      expect(report.errors, spec.name).toEqual([]);
      expect(report.warnings, spec.name).toEqual([]);
      for (const node of Object.values(spec.nodes)) {
        if (node.type === 'shell' || node.type === 'containerStep') {
          expect(isShellImageAllowed(node.image, []), `${spec.name}: ${node.image}`).toBe(true);
        }
      }
    }
  });

  describe.each([...DOC_ORDER])('### `%s`', (type) => {
    it('carries every label and exactly one JSON example', () => {
      const text = section(type);
      for (const label of LABELS) {
        expect(text, label).toContain(label);
      }
      expect(jsonBlocks(text)).toHaveLength(1);
    });

    it('names every field of its schema', () => {
      const text = section(type);
      const own = (SCHEMA_KEYS.get(type) ?? []).filter(
        (k) => k !== 'type' && !COMMON_FIELDS.includes(k)
      );
      for (const field of own) {
        expect(text, `\`${field}\``).toContain(`\`${field}\``);
      }
    });

    it('has a Fields table listing exactly its own schema fields, with the right Required', () => {
      const rows = tableAfter(section(type), '**Fields.**');
      const optional = SCHEMA_OPTIONAL.get(type) ?? new Map<string, boolean>();
      const listed = new Set<string>();
      for (const [fieldCell = '', requiredCell = ''] of rows) {
        for (const field of codeNames(fieldCell)) {
          listed.add(field);
          expect(optional.has(field), `\`${field}\` is a ${type} field`).toBe(true);
          // "yes" is required; "no" or a condition ("for `sidecar`") may be left out.
          expect(requiredCell === 'yes', `Required for \`${field}\``).toBe(
            optional.get(field) === false
          );
        }
      }
      const own = [...optional.keys()].filter((k) => k !== 'type' && !COMMON_FIELDS.includes(k));
      const listedOwn = [...listed].filter((k) => !COMMON_FIELDS.includes(k));
      expect(listedOwn.sort()).toEqual(own.sort());
    });

    it('has an example that uses the node and names each of its edges', () => {
      const text = section(type);
      const nodes = nodesOfType(exampleOf(type), type);
      expect(nodes.length, `a ${type} node in the example`).toBeGreaterThan(0);
      for (const node of nodes) {
        for (const [field] of nodeEdges(node)) {
          const name = field.startsWith('options[') ? 'options' : field;
          expect(text, `edge \`${name}\``).toContain(`\`${name}\``);
        }
      }
    });

    it('names built-in templates that really use the node', () => {
      const claim = paragraphAfter(section(type), '**Built-in examples.**');
      const users = BUILTIN_TEMPLATES.filter((t) => nodesOfType(t.spec, type).length > 0).map(
        (t) => t.name
      );
      if (claim === NONE_BUILT_IN) {
        expect(users).toEqual([]);
        return;
      }
      const named = [...claim.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
      expect(named.length, 'at least one template, or the "None" sentence').toBeGreaterThan(0);
      for (const name of named) {
        expect(users, `${name} uses a ${type} node`).toContain(name);
      }
    });
  });
});
