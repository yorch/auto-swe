import { sectionLink } from '@auto-swe/shared/lib/docSearch';
import { slugifyHeading } from '@auto-swe/shared/lib/docToc';
import {
  collectWorkflowInventory,
  INVENTORY_HEADINGS,
  type InventoryNodeType,
  type InventoryStep,
  type InventoryTemplate,
  stepCategoryTitle,
  summarise,
  type WorkflowInventory,
} from '@auto-swe/shared/workflow/inventory';
import type { StepCategory } from '@auto-swe/shared/workflow/registry-types';

/**
 * The in-app assistant's `workflowInventory` tool, as a pure query over
 * `collectWorkflowInventory()` — the data `docs/workflow-inventory.md` is rendered from, so an
 * answer cannot disagree with the page. `searchDocs` clips a section to a few rows of its tables;
 * this returns every row, cut to the fields a question needs.
 */

export const INVENTORY_KINDS = ['nodeTypes', 'steps', 'templates', 'lookup'] as const;
export type InventoryKind = (typeof INVENTORY_KINDS)[number];

export const INVENTORY_STEP_CATEGORIES = [
  'agent',
  'gate',
  'vcs',
  'control',
  'shell',
] as const satisfies readonly StepCategory[];

export interface InventoryQuery {
  kind: InventoryKind;
  /** `steps` only: one category's steps. Empty means unset. */
  category?: StepCategory | '';
  /** `lookup` only: a node type, step or built-in template name. Empty means unset. */
  name?: string;
}

/** Most partial-name matches a lookup returns, per list. */
const MAX_PARTIAL_MATCHES = 10;
/** A description in a list row is cut to its first sentence, about this long. */
const LIST_DESCRIPTION_CHARS = 200;

const INVENTORY_SLUG = 'workflow-inventory';
const NODES_SLUG = 'workflow-nodes';

const inventoryLink = (heading: string): string =>
  sectionLink(INVENTORY_SLUG, slugifyHeading(heading));

/** The `/docs` link of a node type's section in workflow-nodes.md. */
export const nodeTypeDocLink = (type: string): string =>
  sectionLink(NODES_SLUG, slugifyHeading(type));

/** The `/docs` link of a step category's table in the inventory page. */
export const stepCategoryDocLink = (category: StepCategory): string =>
  inventoryLink(stepCategoryTitle(category));

function nodeTypeRow(t: InventoryNodeType) {
  return {
    doc: nodeTypeDocLink(t.type),
    edges: [...t.edges],
    executorStep: t.executorStep,
    family: t.family,
    templateNodes: t.usage?.nodes ?? 0,
    templates: [...(t.usage?.templates ?? [])],
    type: t.type,
  };
}

/**
 * A step as a row. A list row is compact — description cut to its first sentence, config fields
 * as `key` or `key (required)`, and no per-row link (the answer's `doc` is the same section) —
 * so the whole registry fits one answer; a lookup row is complete.
 */
function stepRow(s: InventoryStep, full: boolean) {
  const row = {
    agentRole: s.agentRole,
    backsNodeType: s.backsNodeType,
    category: s.category,
    description: full ? s.description : summarise(s.description, LIST_DESCRIPTION_CHARS),
    internal: s.internal,
    label: s.label,
    name: s.name,
    templateNodes: s.usage?.nodes ?? 0,
    templates: [...(s.usage?.templates ?? [])],
  };
  return full
    ? {
        ...row,
        configFields: s.configFields.map((f) => ({ ...f })),
        doc: stepCategoryDocLink(s.category),
      }
    : {
        ...row,
        configFields: s.configFields.map((f) => (f.required ? `${f.key} (required)` : f.key)),
      };
}

function templateRow(t: InventoryTemplate, full: boolean) {
  const row = {
    description: full ? t.description : summarise(t.description, LIST_DESCRIPTION_CHARS),
    isDefault: t.isDefault,
    name: t.name,
    nodeCount: t.nodeCount,
    nodeTypes: t.nodeTypes.map((n) => ({ ...n })),
    steps: [...t.steps],
  };
  return full ? { ...row, doc: inventoryLink(INVENTORY_HEADINGS.templates) } : row;
}

export type NodeTypeRow = ReturnType<typeof nodeTypeRow>;
export type StepRow = ReturnType<typeof stepRow>;
export type TemplateRow = ReturnType<typeof templateRow>;

export interface InventoryAnswer {
  kind: InventoryKind;
  /** The section to cite for the whole answer. */
  doc: string;
  totals: { nodeTypes: number; steps: number; internalSteps: number; templates: number };
  nodeTypes?: NodeTypeRow[];
  steps?: StepRow[];
  templates?: TemplateRow[];
  /** Why a lookup came back partial or empty. */
  note?: string;
}

let cached: WorkflowInventory | undefined;

/**
 * The inventory, collected once per process: it is derived from code, so it cannot change. Rows
 * built from it copy its arrays, so nothing a caller does to an answer reaches the cache.
 */
function inventory(): WorkflowInventory {
  cached ??= collectWorkflowInventory();
  return cached;
}

/**
 * Exact (case-insensitive) matches; otherwise the first few names containing the text, with how
 * many contain it in all.
 */
function match<T>(rows: readonly T[], name: (row: T) => string, wanted: string) {
  const w = wanted.toLowerCase();
  const exact = rows.filter((r) => name(r).toLowerCase() === w);
  if (exact.length > 0) {
    return { exact: true, rows: exact, total: exact.length };
  }
  const partial = rows.filter((r) => name(r).toLowerCase().includes(w));
  return { exact: false, rows: partial.slice(0, MAX_PARTIAL_MATCHES), total: partial.length };
}

export function queryWorkflowInventory(query: InventoryQuery): InventoryAnswer {
  const inv = inventory();
  const totals = {
    internalSteps: inv.steps.filter((s) => s.internal).length,
    nodeTypes: inv.nodeTypes.length,
    steps: inv.steps.length,
    templates: inv.templates.length,
  };

  switch (query.kind) {
    case 'nodeTypes':
      return {
        doc: inventoryLink(INVENTORY_HEADINGS.nodeTypes),
        kind: query.kind,
        nodeTypes: inv.nodeTypes.map(nodeTypeRow),
        totals,
      };
    case 'steps': {
      const { category } = query;
      return {
        doc: category ? stepCategoryDocLink(category) : inventoryLink(INVENTORY_HEADINGS.steps),
        kind: query.kind,
        steps: inv.steps
          .filter((s) => !category || s.category === category)
          .map((s) => stepRow(s, false)),
        totals,
      };
    }
    case 'templates':
      return {
        doc: inventoryLink(INVENTORY_HEADINGS.templates),
        kind: query.kind,
        templates: inv.templates.map((t) => templateRow(t, false)),
        totals,
      };
    case 'lookup': {
      const wanted = query.name?.trim() ?? '';
      const doc = sectionLink(INVENTORY_SLUG, null);
      if (!wanted) {
        return { doc, kind: query.kind, note: 'A lookup needs a name.', totals };
      }
      const types = match(inv.nodeTypes, (t) => t.type, wanted);
      const steps = match(inv.steps, (s) => s.name, wanted);
      const templates = match(inv.templates, (t) => t.name, wanted);
      const found = types.total + steps.total + templates.total;
      const exact = types.exact || steps.exact || templates.exact;
      const answer: InventoryAnswer = {
        doc,
        kind: query.kind,
        nodeTypes: (exact && !types.exact ? [] : types.rows).map(nodeTypeRow),
        steps: (exact && !steps.exact ? [] : steps.rows).map((s) => stepRow(s, true)),
        templates: (exact && !templates.exact ? [] : templates.rows).map((t) =>
          templateRow(t, true)
        ),
        totals,
      };
      if (found === 0) {
        answer.note = `No node type, registered step or built-in template is named '${wanted}'. Teams' own templates are not in the inventory.`;
      } else if (!exact) {
        const lists = [
          ['node types', types],
          ['steps', steps],
          ['templates', templates],
        ] as const;
        const cut = lists
          .filter(([, m]) => m.total > m.rows.length)
          .map(([label, m]) => `${label}: first ${m.rows.length} of ${m.total}`);
        answer.note = `Nothing is named exactly '${wanted}'; these names contain it${cut.length ? ` (${cut.join('; ')})` : ''}.`;
      }
      return answer;
    }
  }
}
