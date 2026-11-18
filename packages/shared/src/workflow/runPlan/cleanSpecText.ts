import { plainText } from '../../lib/plainText.js';
import { MAX_NODE_GROUP_LENGTH, MAX_NODE_TITLE_LENGTH } from '../spec.js';
import { buildValidatePhase, canonicalCoreIds } from './canonicalCore.js';
import type { SkeletonMode } from './stepAllowlist.js';

/**
 * The display text a model may write inside a generated plan's nodes, reduced to plain, bounded
 * text (`plainText`): the approver reads it as if the platform had said it, so it carries no
 * hidden, reordering or markup characters, no link or address and no markdown.
 *
 * Fields cleaned, each with the bound its own schema sets:
 *
 * - `title` and `group` on every free node: 80 and 40 characters on a non-human node (an empty
 *   result drops the optional field), 200 and 40 on a human node, whose `title` is required and
 *   falls back to the node id when cleaning empties it;
 * - `description` on a human node (2000, line breaks kept; an empty result drops the field);
 * - the `label` of each `humanDecision` option (100) and each `humanInput` field (100), falling
 *   back to `Option N` / the field's key;
 * - `message` of an `onFailure` / `onExhausted` terminal shorthand (2000; an empty result drops it).
 *
 * Never touched: ids, `next`/`on*` edges, bindings, `inputs`, `config`, option `value`s and select
 * `options` (the identity of a choice), steps, and, unless `mode` is `output-only`, every node of
 * the canonical core or the shipped validate phase, which the exact-match check compares byte for byte. Only strings are rewritten:
 * a value of another type is left for the schema to refuse as it always did. Idempotent, pure,
 * returns a copy.
 */

const HUMAN_TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const OPTION_LABEL_MAX = 100;
const MESSAGE_MAX = 2000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Ids whose nodes are shipped text and must stay exactly as they are. */
function reservedIds(): Set<string> {
  return new Set([...canonicalCoreIds(), ...Object.keys(buildValidatePhase())]);
}

/** Clean `node[field]` when it is a string; an empty result removes an optional field. */
function cleanField(
  node: Record<string, unknown>,
  field: string,
  max: number,
  opts: { multiline?: boolean; fallback?: string } = {}
): void {
  const value = node[field];
  if (typeof value !== 'string') {
    return;
  }
  const cleaned = plainText(value, { max, ...(opts.multiline ? { multiline: true } : {}) });
  if (cleaned !== '') {
    node[field] = cleaned;
  } else if (opts.fallback !== undefined) {
    node[field] = opts.fallback;
  } else {
    delete node[field];
  }
}

function cleanNode(id: string, raw: Record<string, unknown>): Record<string, unknown> {
  const node = { ...raw };
  const type = typeof node.type === 'string' ? node.type : '';
  const human = type.startsWith('human');
  if (human) {
    cleanField(node, 'title', HUMAN_TITLE_MAX, { fallback: id });
    cleanField(node, 'description', DESCRIPTION_MAX, { multiline: true });
  } else {
    cleanField(node, 'title', MAX_NODE_TITLE_LENGTH);
  }
  cleanField(node, 'group', MAX_NODE_GROUP_LENGTH);

  if (type === 'humanDecision' && Array.isArray(node.options)) {
    node.options = node.options.map((opt: unknown, i: number) => {
      if (!isRecord(opt)) {
        return opt;
      }
      const copy = { ...opt };
      cleanField(copy, 'label', OPTION_LABEL_MAX, { fallback: `Option ${i + 1}` });
      return copy;
    });
  }
  if (type === 'humanInput' && Array.isArray(node.fields)) {
    node.fields = node.fields.map((f: unknown) => {
      if (!isRecord(f)) {
        return f;
      }
      const copy = { ...f };
      cleanField(copy, 'label', OPTION_LABEL_MAX, {
        fallback: typeof f.key === 'string' && f.key !== '' ? f.key : 'Field',
      });
      return copy;
    });
  }
  for (const route of ['onFailure', 'onExhausted'] as const) {
    const target = node[route];
    if (isRecord(target) && typeof target.message === 'string') {
      const copy = { ...target };
      cleanField(copy, 'message', MESSAGE_MAX, { multiline: true });
      node[route] = copy;
    }
  }
  return node;
}

/**
 * `spec` with the display text of its free nodes cleaned (see the module comment). A value that is
 * not a spec-shaped object is returned as it is, for the parser to refuse.
 */
export function cleanPlanSpecText<T>(spec: T, mode?: SkeletonMode): T {
  if (!isRecord(spec) || !isRecord(spec.nodes)) {
    return spec;
  }
  // An output-only plan has no core (its ids are ordinary there: `review`, `done`), so none is
  // reserved. Without a mode, or for a delivering plan, the core and validate ids are kept as is.
  const reserved = mode === 'output-only' ? new Set<string>() : reservedIds();
  const nodes: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    nodes[id] = isRecord(node) && !reserved.has(id) ? cleanNode(id, node) : node;
  }
  return { ...spec, nodes } as T;
}
