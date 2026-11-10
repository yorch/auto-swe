/**
 * Editor edits on a macro use: an entry of the spec's `uses` map and the nodes
 * tagged `use: <id>` that its expansion produced (see `workflow/macros.ts`).
 *
 * The flat nodes stay what is saved and run. These helpers only move between the
 * two forms through the shared module's own operations — `reexpandUse` and
 * `detachUse` — and add what an editor needs around them:
 *
 *   - re-expanding with EDITED arguments (validated against the macro's schema
 *     first, so the author sees the schema's own message);
 *   - keeping the rest of the spec routed into the use when the expansion's entry
 *     node changes id (a `ciLoop` with `wait: 'pollOrSignal'` starts at
 *     `loadCiWaitConfig`, not `waitForCI`) — another use's routing arguments
 *     included — and parking any other edge into a node the new expansion no
 *     longer has on the unresolved-branch placeholder, exactly as a delete would;
 *   - detaching a tag that names no `uses` entry (the shared `detachUse` refuses an
 *     unknown use id; here the stray tags are simply stripped).
 *
 * Every function is pure and returns a result object rather than throwing, so the
 * inspector can show the reason in place.
 */
import type { MacroUse, UseProblem, WorkflowSpec } from '@auto-swe/shared/workflow';
import {
  collectUseProblems,
  detachUse,
  getMacro,
  MacroUseError,
  useEntry as macroUseEntry,
  reexpandUse,
} from '@auto-swe/shared/workflow';
import { nodeUseOf } from './nodeDisplay';
import { renameInUseArgs, rewriteEdges } from './specEdits';

export type MacroEditResult = { ok: true; spec: WorkflowSpec } | { ok: false; error: string };
export type ArgsDraftResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/** What the inspector shows about one use. */
export interface MacroUseInfo {
  useId: string;
  /** The declared macro ref, or undefined when no `uses` entry names this id. */
  macroRef?: string;
  /** Whether the ref names a macro this build knows. */
  knownMacro: boolean;
  args?: Record<string, unknown>;
  /** The nodes tagged with the use, in map order. */
  memberIds: string[];
  /** The use's problems (`collectUseProblems`, filtered to it). */
  problems: UseProblem[];
  /** True when one of the problems is drift: the tagged nodes were edited by hand. */
  drifted: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Everything the inspector needs about `useId` in `spec`. */
export function macroUseInfo(spec: WorkflowSpec, useId: string): MacroUseInfo {
  const use = spec.uses && Object.hasOwn(spec.uses, useId) ? spec.uses[useId] : undefined;
  const problems = collectUseProblems(spec).filter((p) => p.useId === useId);
  return {
    args: use?.args,
    drifted: problems.some((p) => p.code === 'USE_DRIFT'),
    knownMacro: use ? getMacro(use.macro) !== undefined : false,
    macroRef: use?.macro,
    memberIds: Object.entries(spec.nodes)
      .filter(([, node]) => nodeUseOf(node) === useId)
      .map(([id]) => id),
    problems,
    useId,
  };
}

/** Pretty JSON for the args textarea. */
export function formatUseArgs(args: Record<string, unknown> | undefined): string {
  return JSON.stringify(args ?? {}, null, 2);
}

/**
 * Parse the args textarea for `macroRef`: JSON first, then the macro's own schema.
 * The error is the JSON parser's or the schema's message, path first.
 */
export function parseUseArgsDraft(macroRef: string, text: string): ArgsDraftResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `Not valid JSON: ${message(err)}`, ok: false };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Arguments must be a JSON object', ok: false };
  }
  const macro = getMacro(macroRef);
  if (!macro) {
    return { error: `Unknown macro '${macroRef}'`, ok: false };
  }
  const parsed = macro.args.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues
        .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(args)'}: ${i.message}`)
        .join('; '),
      ok: false,
    };
  }
  // Store what the author wrote (validated), not the parsed value: the schema may
  // fill defaults, and a stored use should read the way it was written.
  return { args: raw as Record<string, unknown>, ok: true };
}

/** The entry node id of a use, or undefined when it cannot be resolved. */
function entryOf(use: MacroUse | undefined): string | undefined {
  if (!use) {
    return undefined;
  }
  try {
    return macroUseEntry(use);
  } catch {
    return undefined;
  }
}

/**
 * Replace use `useId`'s nodes with a fresh expansion, of `args` when given (the
 * `uses` entry is updated to them) or of its current arguments. Edges from the
 * rest of the spec into the old entry follow the new one; edges into any other
 * node the expansion no longer has are cleared or parked on the placeholder.
 */
export function reexpandUseWithArgs(
  spec: WorkflowSpec,
  useId: string,
  args?: Record<string, unknown>
): MacroEditResult {
  const current = spec.uses && Object.hasOwn(spec.uses, useId) ? spec.uses[useId] : undefined;
  if (!current) {
    return { error: `Use '${useId}' is not declared in the spec's uses`, ok: false };
  }
  const nextUse: MacroUse = args ? { ...current, args } : current;
  const withArgs: WorkflowSpec = { ...spec, uses: { ...spec.uses, [useId]: nextUse } };
  let expanded: WorkflowSpec;
  try {
    expanded = reexpandUse(withArgs, useId);
  } catch (err) {
    if (err instanceof MacroUseError) {
      return { error: err.message, ok: false };
    }
    throw err;
  }

  const oldIds = Object.entries(spec.nodes)
    .filter(([, node]) => nodeUseOf(node) === useId)
    .map(([id]) => id);
  const gone = new Set(oldIds.filter((id) => !Object.hasOwn(expanded.nodes, id)));
  const oldEntry = entryOf(current);
  const newEntry = entryOf(nextUse);
  const entryMoved =
    oldEntry !== undefined &&
    newEntry !== undefined &&
    oldEntry !== newEntry &&
    Object.hasOwn(expanded.nodes, newEntry);
  if (gone.size === 0 && !entryMoved) {
    return { ok: true, spec: expanded };
  }
  // Only edges from OUTSIDE the use are rewritten: the expansion's own edges are what
  // the macro emits (a `pollOrSignal` router still routes on to `waitForCI`, which was
  // the entry before), and changing them would be drift.
  const follow = (target: string): string | null => {
    if (entryMoved && target === oldEntry) {
      return newEntry;
    }
    return gone.has(target) ? null : target;
  };
  const outside: Record<string, WorkflowSpec['nodes'][string]> = {};
  for (const [id, node] of Object.entries(expanded.nodes)) {
    if (nodeUseOf(node) !== useId) {
      outside[id] = node;
    }
  }
  const rewritten = rewriteEdges(outside as WorkflowSpec['nodes'], follow);
  const nodes: Record<string, WorkflowSpec['nodes'][string]> = {};
  for (const [id, node] of Object.entries(expanded.nodes)) {
    nodes[id] = rewritten[id] ?? node;
  }
  // The unresolved-branch placeholder, when an edge into a vanished node needed one.
  for (const [id, node] of Object.entries(rewritten)) {
    nodes[id] ??= node;
  }
  const entry =
    spec.entry === oldEntry && entryMoved
      ? (newEntry as string)
      : gone.has(spec.entry)
        ? (newEntry ?? spec.entry)
        : spec.entry;
  // Another use that routes into this one (`openPullRequest`'s `next`) names the entry in
  // its arguments; it follows too, so its nodes and its arguments still agree.
  const uses = entryMoved
    ? renameInUseArgs(expanded.uses, oldEntry as string, newEntry as string, useId)
    : expanded.uses;
  return {
    ok: true,
    spec: { ...expanded, entry, nodes: nodes as WorkflowSpec['nodes'], ...(uses ? { uses } : {}) },
  };
}

/**
 * Forget use `useId`: its nodes stay as ordinary hand-written nodes and its `uses`
 * entry goes (`uses` itself when it empties). A tag naming no `uses` entry is
 * stripped the same way.
 */
export function detachUseInSpec(spec: WorkflowSpec, useId: string): MacroEditResult {
  if (spec.uses && Object.hasOwn(spec.uses, useId)) {
    try {
      return { ok: true, spec: detachUse(spec, useId) };
    } catch (err) {
      return { error: message(err), ok: false };
    }
  }
  const nodes: Record<string, unknown> = {};
  let changed = false;
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (nodeUseOf(node) === useId) {
      const { use: _use, ...rest } = node;
      nodes[id] = rest;
      changed = true;
    } else {
      nodes[id] = node;
    }
  }
  if (!changed) {
    return { error: `No node is tagged with use '${useId}'`, ok: false };
  }
  return { ok: true, spec: { ...spec, nodes: nodes as WorkflowSpec['nodes'] } };
}
