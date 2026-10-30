/**
 * The workflow inventory — `docs/workflow-inventory.md`, rendered from code.
 *
 * `docs/workflow-nodes.md` explains how to use each node type and is written by hand. This page
 * is the other half: a catalog of what exists — every node type, every registered step, and which
 * built-in templates use them — derived from the spec schema, the step registry and
 * `BUILTIN_TEMPLATES`, so it cannot describe a node or step the code does not have.
 *
 * `collectWorkflowInventory()` gathers it as data — the in-app assistant's `workflowInventory` tool
 * answers from it — and `renderWorkflowInventory()` renders that data as the page. Both are pure
 * and deterministic. `yarn docs:inventory` writes the rendered page to the committed file, and
 * `inventory.test.ts` fails when the two differ.
 */

import { z } from 'zod';
import type { StepCategory, StepFieldDef } from './registry-types.js';
import { type Node, NodeSchema, nodeEdges } from './spec.js';
import { EXECUTOR_STEP_ALIASES, listAllSteps } from './stepRegistry.js';
import { BUILTIN_TEMPLATES, type BuiltinTemplate } from './templates/index.js';

export type NodeType = Node['type'];

/** The editor palette's group labels (`packages/web/src/components/workflow/NodePalette.tsx`). */
export type NodeFamily = 'Execution' | 'Control flow' | 'Human-in-loop' | 'Advanced';

/**
 * Every node type's family, mirroring the editor palette's grouping. A `Record` so a new node
 * type fails typecheck until it is placed.
 */
export const NODE_FAMILIES: Record<NodeType, NodeFamily> = {
  agent: 'Execution',
  cond: 'Control flow',
  containerStep: 'Advanced',
  eval: 'Execution',
  fanOut: 'Control flow',
  humanApproval: 'Human-in-loop',
  humanDecision: 'Human-in-loop',
  humanInput: 'Human-in-loop',
  humanReview: 'Human-in-loop',
  mcp: 'Execution',
  set: 'Control flow',
  shell: 'Advanced',
  signal: 'Control flow',
  step: 'Execution',
  terminate: 'Control flow',
};

const FAMILY_ORDER: readonly NodeFamily[] = [
  'Execution',
  'Control flow',
  'Human-in-loop',
  'Advanced',
];

/** Section order and heading for each step category. */
const STEP_CATEGORIES: Record<StepCategory, { order: number; title: string }> = {
  agent: { order: 0, title: 'Agent steps' },
  control: { order: 3, title: 'Control steps' },
  gate: { order: 1, title: 'Gate steps' },
  shell: { order: 4, title: 'Shell steps' },
  vcs: { order: 2, title: 'Version-control steps' },
};

/** The page's h2 headings, for a reader that links to a section of it. */
export const INVENTORY_HEADINGS = {
  nodeTypes: 'Node types',
  steps: 'Registered steps',
  templates: 'Built-in templates',
} as const;

/** The h3 heading the page gives a step category's table. */
export function stepCategoryTitle(category: StepCategory): string {
  return STEP_CATEGORIES[category].title;
}

export const INVENTORY_DOC_PATH = 'docs/workflow-inventory.md';
export const INVENTORY_COMMAND = 'yarn docs:inventory';

/** Code-point order: the same on every machine, whatever its locale. */
export const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every node type, in schema order. */
export function nodeTypes(): NodeType[] {
  return NodeSchema.options.map((o) => o.shape.type.value as NodeType);
}

function shapeOf(type: NodeType): Record<string, z.ZodType> {
  const option = NodeSchema.options.find((o) => o.shape.type.value === type);
  if (!option) {
    throw new Error(`unknown node type: ${type}`);
  }
  return option.shape as Record<string, z.ZodType>;
}

/** Peel `.optional()` / `.default()` / `.nullable()` wrappers off a schema. */
function unwrap(schema: z.ZodType): z.ZodType {
  let inner = schema;
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodDefault ||
    inner instanceof z.ZodNullable
  ) {
    inner = inner.unwrap() as z.ZodType;
  }
  return inner;
}

/**
 * A stand-in node of `type` on which every field is present: a string naming the field, or —
 * where the schema says the field is an array — one element built the same way. Fed to
 * `nodeEdges`, it reports every edge the type can have, optional ones included.
 */
function probeNode(type: NodeType): Node {
  const probe = (shape: Record<string, z.ZodType>, root: boolean): object =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (typeof key !== 'string') {
            return undefined;
          }
          if (root && key === 'type') {
            return type;
          }
          const field = shape[key] ? unwrap(shape[key]) : undefined;
          if (field instanceof z.ZodArray) {
            const element = unwrap(field.element as z.ZodType);
            return element instanceof z.ZodObject
              ? [probe(element.shape as Record<string, z.ZodType>, false)]
              : [key];
          }
          return key;
        },
      }
    );
  return probe(shapeOf(type), true) as Node;
}

/** Is the field at an edge path (`next`, `options[].next`) optional in the schema? */
function edgeIsOptional(type: NodeType, path: string): boolean {
  let shape = shapeOf(type);
  const parts = path.split('.');
  for (const [i, part] of parts.entries()) {
    const key = part.replace(/\[\]$/, '');
    const field = shape[key];
    if (!field) {
      throw new Error(`edge ${type}.${path}: no schema field '${key}'`);
    }
    if (i === parts.length - 1) {
      return field.isOptional();
    }
    const inner = unwrap(field);
    const element = inner instanceof z.ZodArray ? unwrap(inner.element as z.ZodType) : inner;
    if (!(element instanceof z.ZodObject)) {
      throw new Error(`edge ${type}.${path}: '${key}' is not an object or an array of objects`);
    }
    shape = element.shape as Record<string, z.ZodType>;
  }
  return false;
}

/**
 * A node type's outgoing edge fields as `nodeEdges` — the single source of truth for edges, used
 * by the schema's ref check and by `validateSpec` — reports them, with array indexes collapsed
 * (`options[0].next` → `options[].next`). The schema supplies only the `?` on an optional edge.
 */
export function edgeFields(type: NodeType): string[] {
  const fields = new Set(
    nodeEdges(probeNode(type)).map(([field]) => field.replace(/\[\d+\]/g, '[]'))
  );
  return [...fields].sort(byCodePoint).map((f) => (edgeIsOptional(type, f) ? `${f}?` : f));
}

/** Node type → the registered executor step it dispatches through, if any. */
export function executorStepFor(type: NodeType): string | undefined {
  return Object.entries(EXECUTOR_STEP_ALIASES)
    .filter(([, nodeType]) => nodeType === type)
    .map(([step]) => step)
    .sort(byCodePoint)[0];
}

interface Usage {
  nodes: number;
  templates: string[];
}

function addUsage(map: Map<string, Usage>, key: string, template: string): void {
  const usage = map.get(key) ?? { nodes: 0, templates: [] };
  usage.nodes += 1;
  if (!usage.templates.includes(template)) {
    usage.templates.push(template);
  }
  map.set(key, usage);
}

/**
 * Node-type and step usage across the given templates. A step counts a `step` node naming it,
 * and — for an executor step — every node of the type it backs, since that node dispatches
 * through it.
 */
export function templateUsage(templates: readonly BuiltinTemplate[] = BUILTIN_TEMPLATES): {
  byNodeType: Map<string, Usage>;
  byStep: Map<string, Usage>;
} {
  const byNodeType = new Map<string, Usage>();
  const byStep = new Map<string, Usage>();
  for (const t of templates) {
    for (const node of Object.values(t.spec.nodes)) {
      addUsage(byNodeType, node.type, t.name);
      if (node.type === 'step') {
        addUsage(byStep, node.step, t.name);
      } else {
        const step = executorStepFor(node.type);
        if (step) {
          addUsage(byStep, step, t.name);
        }
      }
    }
  }
  for (const usage of [...byNodeType.values(), ...byStep.values()]) {
    usage.templates.sort(byCodePoint);
  }
  return { byNodeType, byStep };
}

/**
 * Make free text safe for one table cell: no row breaks; no column breaks (`|` is escaped inside
 * code spans too, because a GFM table splits rows on it before it reads them); and no `<name>`
 * outside a code span that a markdown renderer would swallow as an HTML tag. Inside a code span
 * `<` is already literal, and an entity there would render as typed.
 */
export function tableCell(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('')
    .replace(/\|/g, '\\|');
}

/** A description cut to its first sentence, and that to about `max` characters at a word. */
export function summarise(text: string, max = 160): string {
  const first = text.trim().split(/(?<!\be\.g)\.\s/)[0] ?? '';
  const sentence = first.endsWith('.') ? first : `${first}.`;
  if (sentence.length <= max) {
    return sentence;
  }
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '')}…`;
}

/** How often a node type or step appears in the built-in templates, and in which. */
export interface InventoryUsage {
  /** Nodes across the built-in templates that are of the type, or dispatch through the step. */
  nodes: number;
  /** Names of the built-in templates holding at least one such node, in code-point order. */
  templates: string[];
}

export interface InventoryNodeType {
  type: NodeType;
  family: NodeFamily;
  /** Outgoing edge fields, as {@link edgeFields} reports them (`?` marks an optional one). */
  edges: string[];
  /** The registered step the node dispatches through, if any. */
  executorStep: string | null;
  /** Null when no built-in template uses the type. */
  usage: InventoryUsage | null;
}

export interface InventoryConfigField {
  key: string;
  label: string;
  type: StepFieldDef['type'];
  required: boolean;
}

export interface InventoryStep {
  name: string;
  category: StepCategory;
  label: string;
  description: string;
  /** In key order. */
  configFields: InventoryConfigField[];
  /** The node type this step is the executor of, if any. */
  backsNodeType: NodeType | null;
  /** Refused outside the system template that owns it; not in the editor's palette. */
  internal: boolean;
  /** The cost estimator's agent role for the step, if it names one. */
  agentRole: string | null;
  /** Null when no built-in template uses the step. */
  usage: InventoryUsage | null;
}

export interface InventoryTemplate {
  name: string;
  isDefault: boolean;
  description: string;
  nodeCount: number;
  /** Node types the template is made of, with how many nodes of each, in type order. */
  nodeTypes: { type: string; count: number }[];
  /**
   * Registered steps its nodes dispatch through — named by a `step` node, or the executor of
   * another node's type — in code-point order.
   */
  steps: string[];
}

/** Everything `docs/workflow-inventory.md` shows, as data. */
export interface WorkflowInventory {
  /** By palette family, then name. */
  nodeTypes: InventoryNodeType[];
  /** By category (the page's section order), then name. */
  steps: InventoryStep[];
  /** By name. */
  templates: InventoryTemplate[];
}

/** The step categories in the order the page lists them. */
export function stepCategoryOrder(): StepCategory[] {
  return (Object.keys(STEP_CATEGORIES) as StepCategory[]).sort(
    (a, b) => STEP_CATEGORIES[a].order - STEP_CATEGORIES[b].order
  );
}

/**
 * The workflow inventory as data: the single source for `docs/workflow-inventory.md` and for
 * anything else that answers "what node types, steps and built-in templates exist". Pure and
 * deterministic, like the renderer built on it.
 */
export function collectWorkflowInventory(): WorkflowInventory {
  const { byNodeType, byStep } = templateUsage();
  const usageOf = (usage: Usage | undefined): InventoryUsage | null =>
    usage ? { nodes: usage.nodes, templates: [...usage.templates] } : null;

  const types = nodeTypes().sort(
    (a, b) =>
      FAMILY_ORDER.indexOf(NODE_FAMILIES[a]) - FAMILY_ORDER.indexOf(NODE_FAMILIES[b]) ||
      byCodePoint(a, b)
  );
  const categories = stepCategoryOrder();
  const steps = listAllSteps().sort(
    (a, b) =>
      categories.indexOf(a.category) - categories.indexOf(b.category) || byCodePoint(a.name, b.name)
  );

  return {
    nodeTypes: types.map((type) => ({
      edges: edgeFields(type),
      executorStep: executorStepFor(type) ?? null,
      family: NODE_FAMILIES[type],
      type,
      usage: usageOf(byNodeType.get(type)),
    })),
    steps: steps.map((step) => ({
      agentRole: step.costHint?.role ?? null,
      backsNodeType: (EXECUTOR_STEP_ALIASES[step.name] as NodeType | undefined) ?? null,
      category: step.category,
      configFields: [...step.configFields]
        .sort((a, b) => byCodePoint(a.key, b.key))
        .map((f) => ({ key: f.key, label: f.label, required: !!f.required, type: f.type })),
      description: step.description,
      internal: !!step.internal,
      label: step.label,
      name: step.name,
      usage: usageOf(byStep.get(step.name)),
    })),
    templates: [...BUILTIN_TEMPLATES]
      .sort((a, b) => byCodePoint(a.name, b.name))
      .map((t) => {
        const counts = new Map<string, number>();
        const stepNames = new Set<string>();
        const nodes = Object.values(t.spec.nodes);
        for (const node of nodes) {
          counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
          const step = node.type === 'step' ? node.step : executorStepFor(node.type);
          if (step) {
            stepNames.add(step);
          }
        }
        return {
          description: t.description,
          isDefault: !!t.isDefault,
          name: t.name,
          nodeCount: nodes.length,
          nodeTypes: [...counts.entries()]
            .sort(([a], [b]) => byCodePoint(a, b))
            .map(([type, count]) => ({ count, type })),
          steps: [...stepNames].sort(byCodePoint),
        };
      }),
  };
}

const code = (s: string): string => `\`${s}\``;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function usageCell(usage: InventoryUsage | null, templateCount: number): string {
  if (!usage) {
    return '—';
  }
  const nodes = plural(usage.nodes, 'node');
  if (usage.templates.length === templateCount) {
    return `${nodes} in all ${templateCount} templates`;
  }
  return `${nodes} in ${plural(usage.templates.length, 'template')}: ${usage.templates.map(code).join(', ')}`;
}

function nodeTypeLink(type: string): string {
  return `[${code(type)}](./workflow-nodes.md#${type.toLowerCase()})`;
}

function configCell(step: InventoryStep): string {
  if (step.configFields.length === 0) {
    return '—';
  }
  return step.configFields
    .map((f) => `${code(f.key)}${f.required ? ' (required)' : ''}`)
    .join(', ');
}

function renderNodeTypes(inventory: WorkflowInventory): string[] {
  const lines = [
    `## ${INVENTORY_HEADINGS.nodeTypes}`,
    '',
    'Each type links to its section of [workflow-nodes.md](./workflow-nodes.md), which documents',
    'its fields, output and failure handling. Families are the groups of the editor’s node',
    'palette. The two Advanced types, `shell` and `containerStep`, run a container, so saving a',
    'spec that has one needs the container-authoring permission: the team-admin role on the',
    'template’s team, or platform admin for a global template. Outgoing edges are the fields that',
    'name another node; a `?` marks an optional one. An executor step is the registered step a',
    'node dispatches through — the same step a `step` node may name directly.',
    '',
    '| Type | Family | Outgoing edges | Executor step | Built-in templates |',
    '|---|---|---|---|---|',
  ];
  for (const t of inventory.nodeTypes) {
    lines.push(
      `| ${nodeTypeLink(t.type)} | ${t.family} | ${t.edges.length ? t.edges.map(code).join(', ') : '—'} | ${t.executorStep ? code(t.executorStep) : '—'} | ${usageCell(t.usage, inventory.templates.length)} |`
    );
  }
  return lines;
}

function renderSteps(inventory: WorkflowInventory): string[] {
  const lines = [
    `## ${INVENTORY_HEADINGS.steps}`,
    '',
    'The steps a `step` node can name, grouped by category. Config fields are the `config` keys',
    'the editor’s form offers for the step, as its registry entry declares them; an executor may',
    'read others. The agent role is the model-backed agent whose price the cost estimator uses for',
    'the step. An internal step is refused in any template other than the system template that',
    'owns it, and is left out of the editor’s palette. A step’s built-in template usage counts',
    '`step` nodes naming it and, for an executor step, nodes of the type it backs.',
  ];
  for (const category of stepCategoryOrder()) {
    const inCategory = inventory.steps.filter((s) => s.category === category);
    if (inCategory.length === 0) {
      continue;
    }
    lines.push(
      '',
      `### ${stepCategoryTitle(category)}`,
      '',
      '| Step | Label | Description | Config fields | Agent role | Built-in templates |',
      '|---|---|---|---|---|---|'
    );
    for (const step of inCategory) {
      const notes: string[] = [];
      if (step.backsNodeType) {
        notes.push(`backs ${nodeTypeLink(step.backsNodeType)}`);
      }
      if (step.internal) {
        notes.push('internal');
      }
      const name = `${code(step.name)}${notes.length ? ` (${notes.join(', ')})` : ''}`;
      const role = step.agentRole ? code(step.agentRole) : '—';
      lines.push(
        `| ${name} | ${tableCell(step.label)} | ${tableCell(step.description)} | ${configCell(step)} | ${role} | ${usageCell(step.usage, inventory.templates.length)} |`
      );
    }
  }
  return lines;
}

function renderTemplates(inventory: WorkflowInventory): string[] {
  const lines = [
    `## ${INVENTORY_HEADINGS.templates}`,
    '',
    'What each built-in template does (the first sentence of its description) and the node types',
    'it is made of, with how many nodes of each.',
    '',
    '| Template | Description | Nodes | Node types |',
    '|---|---|---|---|',
  ];
  for (const t of inventory.templates) {
    const types = t.nodeTypes.map(({ type, count }) => `${code(type)} ×${count}`).join(', ');
    lines.push(
      `| ${code(t.name)}${t.isDefault ? ' (default)' : ''} | ${tableCell(summarise(t.description))} | ${t.nodeCount} | ${types} |`
    );
  }
  return lines;
}

/** The full markdown of `docs/workflow-inventory.md`. */
export function renderWorkflowInventory(): string {
  const inventory = collectWorkflowInventory();
  const lines = [
    '# Workflow inventory',
    '',
    'A catalog of the building blocks of a workflow spec: the node types the schema accepts, the',
    'steps the step registry holds, and which built-in templates use each. It lists what exists;',
    '[workflow-nodes.md](./workflow-nodes.md) explains how to use it. This page is generated from',
    `the code by ${code(INVENTORY_COMMAND)}, and a test fails when it no longer matches.`,
    '',
    ...renderNodeTypes(inventory),
    '',
    ...renderSteps(inventory),
    '',
    ...renderTemplates(inventory),
    '',
    '## Limitations',
    '',
    '- It lists what exists, not how it behaves: fields, edges, output and failure handling for each',
    '  node type are in [workflow-nodes.md](./workflow-nodes.md), and a step does what its executor',
    '  in the worker does, which this page does not describe beyond the registry description.',
    '- Config fields are what the editor’s form offers, not a full contract: an executor can read',
    '  keys its registry entry does not declare, and several accept a field from `inputs` instead.',
    '- Template usage covers the built-in templates only. Teams’ own templates, bundle-installed',
    '  templates and the system templates that own internal steps are not counted, so a step with no',
    '  built-in usage may still be in use.',
    '- The agent role is the cost estimator’s hint, not a binding: an `agent` node runs whichever',
    '  library agent it references, and a step may resolve a different agent at run time.',
    '',
  ];
  return lines.join('\n');
}
