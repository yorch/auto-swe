import { plainText } from '@auto-swe/shared/lib/plainText';

/**
 * What the plan preview says about one node beyond its id and type: which agent it runs, what it
 * reads (binding source paths only, never a literal), what it writes, and whether its output
 * becomes guidance for the implementer. Pure over the stored spec JSON, and tolerant of a shape it
 * does not know: anything unexpected is left out rather than guessed at.
 */

export const PLAN_NOTES_PATH = 'context.planNotes';
/** A node's own message text, shown cleaned and bounded. */
export const NODE_MESSAGE_MAX_CHARS = 500;

export interface NodeInputView {
  key: string;
  /** The path the input is read from, or null when it is not a plain `from` binding. */
  from: string | null;
  /** Whether the binding carries a fallback value for an empty path. The value is never shown. */
  hasDefault: boolean;
}

export interface NodeDetail {
  agentRef: string | null;
  inputs: NodeInputView[];
  writes: string[];
  feedsImplementer: boolean;
  message?: string;
}

type Raw = Record<string, unknown>;
const rec = (v: unknown): Raw =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};

function fromOf(binding: unknown): string | null {
  const from = rec(binding).from;
  return typeof from === 'string' ? from : null;
}

function inputsOf(node: Raw): NodeInputView[] {
  return Object.entries(rec(node.inputs)).map(([key, binding]) => ({
    from: fromOf(binding),
    hasDefault: rec(binding).default !== undefined,
    key,
  }));
}

function writesOf(node: Raw): string[] {
  const out = Object.keys(rec(node.values));
  if (typeof node.storeAs === 'string') {
    out.push(node.storeAs);
  }
  return out;
}

/** Every path a node reads through a plain `from` binding. */
function readsOf(node: Raw): string[] {
  const paths = inputsOf(node)
    .map((i) => i.from)
    .filter((f): f is string => f !== null);
  for (const binding of Object.values(rec(node.values))) {
    const from = fromOf(binding);
    if (from !== null) {
      paths.push(from);
    }
  }
  return paths;
}

/** `nodes.<id>.output...` names the node whose output is read. */
function nodeOfPath(path: string): string | undefined {
  return /^nodes\.([^.[\]]+)\.output(?:[.[]|$)/.exec(path)?.[1];
}

const overlaps = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/**
 * The ids of the non-core nodes whose output ends up in `context.planNotes`: a node that writes it,
 * and, transitively, every node whose output such a node reads, directly or through a context path.
 */
export function nodesFeedingImplementer(
  nodes: Record<string, unknown>,
  coreIds: ReadonlySet<string>
): Set<string> {
  const fed = new Set<string>();
  const tainted = new Set<string>([PLAN_NOTES_PATH]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, raw] of Object.entries(nodes)) {
      if (coreIds.has(id)) {
        continue;
      }
      const node = rec(raw);
      if (!fed.has(id) && writesOf(node).some((w) => [...tainted].some((t) => overlaps(w, t)))) {
        fed.add(id);
        changed = true;
      }
      if (!fed.has(id)) {
        continue;
      }
      for (const path of readsOf(node)) {
        const source = nodeOfPath(path);
        if (source !== undefined) {
          if (!coreIds.has(source) && !fed.has(source) && Object.hasOwn(nodes, source)) {
            fed.add(source);
            changed = true;
          }
        } else if (path.startsWith('context.') && !tainted.has(path)) {
          tainted.add(path);
          changed = true;
        }
      }
    }
  }
  return fed;
}

export function describeNode(raw: unknown, feedsImplementer: boolean): NodeDetail {
  const node = rec(raw);
  const message =
    typeof node.userMessage === 'string'
      ? plainText(node.userMessage, { max: NODE_MESSAGE_MAX_CHARS, multiline: true })
      : '';
  return {
    agentRef: node.type === 'agent' && typeof node.agentRef === 'string' ? node.agentRef : null,
    feedsImplementer,
    inputs: inputsOf(node),
    writes: writesOf(node),
    ...(message !== '' ? { message } : {}),
  };
}
