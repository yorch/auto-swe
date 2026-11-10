/**
 * Workflow macros: the authored form of a spec, kept beside the flat one.
 *
 * The built-in templates are written with the authoring helpers in
 * `templates/authoring/` (`ciLoop`, `reviewLoop`, …), plain functions that return
 * flat nodes under fixed ids. A spec may record that it was built that way: its
 * top-level `uses` map names, per use id, a versioned macro and the JSON
 * arguments it was expanded with, and every node the expansion produced carries
 * `use: <id>`.
 *
 * The flat `nodes` stay the canonical form. They are what is stored, hashed,
 * diffed and run; the interpreter and the worker never read `uses` or `use`.
 * This module only moves between the two forms and checks they agree:
 *
 *   - {@link expandUse}        one use's nodes, tagged
 *   - {@link materializeUses}  write path: insert the nodes of any use that has none
 *   - {@link reexpandUse}      replace a use's nodes with a fresh expansion
 *   - {@link detachUse}        forget the use, keep its nodes as hand-written ones
 *   - {@link findUseProblems}  unknown macro, bad arguments, orphan tags, drift
 *
 * A macro is versioned (`ciLoop@1`) so that changing what a helper emits is a new
 * version, not a silent change to the meaning of every stored use: a stored use
 * whose helper output changed shows up as drift, which the author resolves by
 * re-expanding or detaching.
 *
 * Pure, deterministic and I/O-free. It imports the authoring helpers, so it must
 * not be imported by `spec.ts` (which the Temporal workflow isolate loads).
 */

import { z } from 'zod';
import { MAX_EXPR_LENGTH, type MacroUse, type Node, NodeSchema, USE_ID_RE } from './spec.js';
import {
  type CiLoopOptions,
  ciLoop,
  ciWaitEntry,
  type NodeMap,
  type OpenPullRequestOptions,
  openPullRequest,
  type ReviewLoopOptions,
  reviewLoop,
  type ValidatePhaseOptions,
  validatePhase,
  validatePhaseEntry,
} from './templates/authoring/index.js';

export type { MacroUse } from './spec.js';

/** One versioned macro: an argument schema and the helper it expands through. */
export interface MacroDefinition<A = unknown> {
  /** `<name>@<version>`, the value a use's `macro` field names. */
  readonly ref: string;
  /** Strict JSON mirror of the helper's options type. */
  readonly args: z.ZodType<A>;
  // Method syntax on purpose: a definition for specific arguments is then usable
  // as a `MacroDefinition<unknown>`, which is how the registry holds them all.
  /** The helper's output for these arguments, unchanged. */
  expand(args: A): NodeMap;
  /** The node other nodes route to in order to enter the expansion. */
  entry(args: A): string;
  /**
   * Argument paths (dotted) whose value is a node id OUTSIDE the expansion that it
   * routes to. Informational, for tooling that follows or renames edges.
   */
  readonly edgeArgs: readonly string[];
  /**
   * Argument paths whose value names a node the expansion itself EMITS (so the
   * id is the author's choice). Informational, like {@link edgeArgs}.
   */
  readonly nodeIdArgs: readonly string[];
}

const NodeRef = z.string().min(1).max(64);
const DomainStatus = z.string().min(1).max(64);
/** `maxVisits` is at most 10 000 and the loops set it to `limit - 1`. */
const LoopLimit = z.number().int().min(2).max(10_001);

const CiLoopArgs = z.strictObject({
  exhausted: NodeRef.optional(),
  fix: z.union([
    z.literal(false),
    z.strictObject({
      handoff: z.union([
        z.strictObject({ repush: NodeRef, status: DomainStatus.optional() }),
        z.strictObject({ rereview: NodeRef }),
      ]),
      limit: z.union([LoopLimit, z.string().min(1).max(MAX_EXPR_LENGTH)]).optional(),
      retryIfUnchanged: z.boolean().optional(),
    }),
  ]),
  passed: NodeRef,
  wait: z.enum(['signal', 'pollOrSignal']).optional(),
}) satisfies z.ZodType<CiLoopOptions>;

const ReviewLoopArgs = z.strictObject({
  afterFix: NodeRef.optional(),
  approved: NodeRef,
  exhausted: NodeRef.optional(),
  fixConfig: z.record(z.string(), z.unknown()).optional(),
  limit: LoopLimit.optional(),
}) satisfies z.ZodType<ReviewLoopOptions>;

const ValidatePhaseArgs = z.strictObject({
  next: NodeRef,
  stamp: z.boolean().optional(),
  stopIfNotActionable: z.boolean().optional(),
  successCriteria: z.boolean().optional(),
  successCriteriaId: NodeRef.optional(),
  ticketContext: z.boolean().optional(),
}) satisfies z.ZodType<ValidatePhaseOptions>;

const OpenPullRequestArgs = z.strictObject({
  draft: z.boolean().optional(),
  next: NodeRef,
  resetCiRetries: z.boolean().optional(),
  status: DomainStatus.optional(),
}) satisfies z.ZodType<OpenPullRequestOptions>;

function define<A>(def: MacroDefinition<A>): MacroDefinition<A> {
  return Object.freeze(def);
}

/** Every macro a spec may use, by `<name>@<version>`. */
export const MACROS: Readonly<Record<string, MacroDefinition<unknown>>> = Object.freeze({
  'ciLoop@1': define({
    args: CiLoopArgs,
    edgeArgs: ['passed', 'exhausted', 'fix.handoff.rereview'],
    entry: (a) => ciWaitEntry(a.wait),
    expand: (a) => ciLoop(a),
    nodeIdArgs: ['fix.handoff.repush'],
    ref: 'ciLoop@1',
  }),
  'openPullRequest@1': define({
    args: OpenPullRequestArgs,
    edgeArgs: ['next'],
    entry: () => 'openPR',
    expand: (a) => openPullRequest(a),
    nodeIdArgs: [],
    ref: 'openPullRequest@1',
  }),
  'reviewLoop@1': define({
    args: ReviewLoopArgs,
    edgeArgs: ['approved', 'afterFix', 'exhausted'],
    entry: () => 'review',
    expand: (a) => reviewLoop(a),
    nodeIdArgs: [],
    ref: 'reviewLoop@1',
  }),
  'validatePhase@1': define({
    args: ValidatePhaseArgs,
    edgeArgs: ['next'],
    entry: (a) => validatePhaseEntry(a),
    expand: (a) => validatePhase(a),
    nodeIdArgs: ['successCriteriaId'],
    ref: 'validatePhase@1',
  }),
});

/** The macro a `macro` reference names, or undefined. */
export function getMacro(ref: string): MacroDefinition<unknown> | undefined {
  return Object.hasOwn(MACROS, ref) ? MACROS[ref] : undefined;
}

/** Thrown when a use cannot be expanded or applied. The message names the use and the cause. */
export class MacroUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MacroUseError';
  }
}

/** Is `id` a valid key for the spec's `uses` map (and a node's `use` tag)? */
export function isValidUseId(id: string): boolean {
  return USE_ID_RE.test(id);
}

function describeUnknownMacro(ref: string): string {
  const name = ref.split('@')[0] ?? ref;
  const versions = Object.keys(MACROS).filter((k) => k.startsWith(`${name}@`));
  if (versions.length > 0) {
    return `unknown version of macro '${name}' ('${ref}'; known: ${versions.join(', ')})`;
  }
  return `unknown macro '${ref}' (known: ${Object.keys(MACROS).join(', ')})`;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(args)'}: ${i.message}`)
    .join('; ');
}

type Resolved =
  | { ok: true; macro: MacroDefinition<unknown>; args: unknown }
  | {
      ok: false;
      code: 'USE_INVALID' | 'USE_UNKNOWN_MACRO' | 'USE_INVALID_ARGS';
      problem: string;
    };

/** Resolve a use's macro and parse its arguments, without expanding. */
function resolveUse(ref: unknown): Resolved {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    return { code: 'USE_INVALID', ok: false, problem: 'must be an object { macro, args }' };
  }
  const { macro: macroRef, args } = ref as { macro?: unknown; args?: unknown };
  if (typeof macroRef !== 'string') {
    return {
      code: 'USE_INVALID',
      ok: false,
      problem: "'macro' must be a string such as 'ciLoop@1'",
    };
  }
  const macro = getMacro(macroRef);
  if (!macro) {
    return { code: 'USE_UNKNOWN_MACRO', ok: false, problem: describeUnknownMacro(macroRef) };
  }
  const parsed = macro.args.safeParse(args);
  if (!parsed.success) {
    return {
      code: 'USE_INVALID_ARGS',
      ok: false,
      problem: `invalid arguments for '${macroRef}': ${formatZodIssues(parsed.error)}`,
    };
  }
  return { args: parsed.data, macro, ok: true };
}

/**
 * The nodes one use expands to: the macro helper's output for its arguments,
 * each node a fresh clone stamped `use: useId`. Throws {@link MacroUseError} for a
 * bad use id, an unknown macro or arguments its schema refuses.
 */
export function expandUse(useId: string, ref: MacroUse): NodeMap {
  if (!isValidUseId(useId)) {
    throw new MacroUseError(
      `use '${useId}': a use id is a letter followed by up to 31 letters or digits`
    );
  }
  const resolved = resolveUse(ref);
  if (!resolved.ok) {
    throw new MacroUseError(`use '${useId}': ${resolved.problem}`);
  }
  let nodes: NodeMap;
  try {
    nodes = resolved.macro.expand(resolved.args);
  } catch (err) {
    throw new MacroUseError(
      `use '${useId}': '${resolved.macro.ref}' failed to expand: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const out: NodeMap = {};
  for (const [id, node] of Object.entries(nodes)) {
    out[id] = { ...structuredClone(node), use: useId } as Node;
  }
  return out;
}

/** The entry node id of a use's expansion (where other nodes route to enter it). */
export function useEntry(ref: MacroUse): string {
  const resolved = resolveUse(ref);
  if (!resolved.ok) {
    throw new MacroUseError(resolved.problem);
  }
  return resolved.macro.entry(resolved.args);
}

// ── Spec-level operations ────────────────────────────────────────────────────

type RawNodes = Record<string, unknown>;
/** The parts of a (raw or parsed) spec this module touches. */
interface SpecWithUses {
  nodes?: unknown;
  uses?: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The trimmed `use` tag of a raw or parsed node, or undefined. */
function tagOf(node: unknown): string | undefined {
  if (!isPlainObject(node) || typeof node.use !== 'string') {
    return undefined;
  }
  const t = node.use.trim();
  return t.length > 0 ? t : undefined;
}

function nodesOf(spec: SpecWithUses): RawNodes {
  return isPlainObject(spec.nodes) ? spec.nodes : {};
}

function usesOf(spec: SpecWithUses): Record<string, unknown> {
  return isPlainObject(spec.uses) ? spec.uses : {};
}

/** Insert `expansion` into `nodes`, refusing to replace a node that is already there. */
function insertExpansion(nodes: RawNodes, useId: string, expansion: NodeMap): void {
  for (const [id, node] of Object.entries(expansion)) {
    if (Object.hasOwn(nodes, id)) {
      const owner = tagOf(nodes[id]);
      throw new MacroUseError(
        `use '${useId}': its expansion defines node '${id}', which the spec already has ${
          owner ? `(from use '${owner}')` : '(a hand-written node)'
        }`
      );
    }
    nodes[id] = node;
  }
}

/**
 * The WRITE path: make the flat nodes agree with `uses` where they are missing.
 * For every use that no node is tagged with, its expansion is inserted; a use
 * whose nodes are already present is left alone (drift is reported by
 * {@link findUseProblems}, never silently repaired). Returns a new object and
 * leaves the argument untouched; a spec with no (or an empty) `uses` is returned
 * as-is, the same reference. Throws {@link MacroUseError} when a use cannot be
 * expanded or its expansion would replace an existing node (naming the id).
 * Idempotent: materialising the result again changes nothing.
 */
export function materializeUses<T>(rawSpec: T): T {
  if (!isPlainObject(rawSpec)) {
    return rawSpec;
  }
  const spec = rawSpec as SpecWithUses;
  if (spec.uses === undefined) {
    return rawSpec;
  }
  if (!isPlainObject(spec.uses)) {
    throw new MacroUseError("'uses' must be an object of { macro, args } keyed by use id");
  }
  const uses = spec.uses;
  if (Object.keys(uses).length === 0) {
    return rawSpec;
  }
  const tagged = new Set<string>();
  for (const node of Object.values(nodesOf(spec))) {
    const tag = tagOf(node);
    if (tag) {
      tagged.add(tag);
    }
  }
  const nodes: RawNodes = { ...nodesOf(spec) };
  let changed = false;
  for (const [useId, ref] of Object.entries(uses)) {
    if (tagged.has(useId)) {
      continue;
    }
    insertExpansion(nodes, useId, expandUse(useId, ref as MacroUse));
    changed = true;
  }
  return changed ? ({ ...rawSpec, nodes } as T) : ({ ...rawSpec } as T);
}

/**
 * Replace a use's nodes with a fresh expansion of its current arguments. Every
 * node tagged with the id is removed and the expansion inserted; edges from the
 * rest of the spec name node ids, so they stay valid. Returns a new spec. Throws
 * {@link MacroUseError} for an unknown use id, a use that cannot be expanded, or
 * an expansion that would replace a node outside the use.
 */
export function reexpandUse<T extends SpecWithUses>(spec: T, useId: string): T {
  const uses = usesOf(spec);
  if (!Object.hasOwn(uses, useId)) {
    throw new MacroUseError(`use '${useId}' is not in the spec's uses`);
  }
  const expansion = expandUse(useId, uses[useId] as MacroUse);
  const nodes: RawNodes = {};
  for (const [id, node] of Object.entries(nodesOf(spec))) {
    if (tagOf(node) !== useId) {
      nodes[id] = node;
    }
  }
  insertExpansion(nodes, useId, expansion);
  return { ...spec, nodes };
}

/**
 * Forget a use: delete its `uses` entry and strip the tag from its nodes, which
 * stay in the spec as hand-written nodes. `uses` is dropped when it becomes
 * empty. Returns a new spec. Throws {@link MacroUseError} for an unknown use id.
 */
export function detachUse<T extends SpecWithUses>(spec: T, useId: string): T {
  const uses = usesOf(spec);
  if (!Object.hasOwn(uses, useId)) {
    throw new MacroUseError(`use '${useId}' is not in the spec's uses`);
  }
  const nodes: RawNodes = {};
  for (const [id, node] of Object.entries(nodesOf(spec))) {
    if (tagOf(node) === useId) {
      const { use: _use, ...rest } = node as Record<string, unknown>;
      nodes[id] = rest;
    } else {
      nodes[id] = node;
    }
  }
  const { [useId]: _gone, ...remaining } = uses;
  const { uses: _uses, ...withoutUses } = spec as T & { uses?: unknown };
  return (
    Object.keys(remaining).length > 0
      ? { ...withoutUses, nodes, uses: remaining }
      : { ...withoutUses, nodes }
  ) as T;
}

// ── Checking ────────────────────────────────────────────────────────────────

export type UseProblemCode =
  | 'USE_INVALID_ID'
  | 'USE_INVALID'
  | 'USE_UNKNOWN_MACRO'
  | 'USE_INVALID_ARGS'
  | 'USE_EXPAND_FAILED'
  | 'USE_NOT_DECLARED'
  | 'USE_NO_NODES'
  | 'USE_DRIFT';

export interface UseProblem {
  code: UseProblemCode;
  /** The `uses` key the problem concerns. */
  useId: string;
  /** The node concerned, for a problem about one node. */
  nodeId?: string;
  message: string;
}

/**
 * A node in the form the schema reads it (defaults applied, labels trimmed),
 * serialised with sorted keys. Two nodes that parse to the same value compare
 * equal whatever their key order, and a raw node compares equal to its parsed
 * form.
 */
function canonicalNode(node: unknown): string {
  const parsed = NodeSchema.safeParse(node);
  const value = parsed.success ? parsed.data : node;
  return JSON.stringify(value, (_k, v) =>
    isPlainObject(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]])
        )
      : v
  );
}

/** Every disagreement between a spec's `uses` and its flat nodes, structured. */
export function collectUseProblems(spec: SpecWithUses): UseProblem[] {
  const problems: UseProblem[] = [];
  const nodes = nodesOf(spec);
  const uses = usesOf(spec);
  const byTag = new Map<string, string[]>();
  for (const [id, node] of Object.entries(nodes)) {
    const tag = tagOf(node);
    if (tag) {
      byTag.set(tag, [...(byTag.get(tag) ?? []), id]);
    }
  }
  if (spec.uses !== undefined && !isPlainObject(spec.uses)) {
    problems.push({
      code: 'USE_INVALID',
      message: "'uses' must be an object of { macro, args } keyed by use id",
      useId: '',
    });
  }

  for (const [useId, ref] of Object.entries(uses)) {
    if (!isValidUseId(useId)) {
      problems.push({
        code: 'USE_INVALID_ID',
        message: `use '${useId}': a use id is a letter followed by up to 31 letters or digits`,
        useId,
      });
      continue;
    }
    const resolved = resolveUse(ref);
    if (!resolved.ok) {
      problems.push({ code: resolved.code, message: `use '${useId}': ${resolved.problem}`, useId });
      continue;
    }
    const tagged = byTag.get(useId) ?? [];
    if (tagged.length === 0) {
      problems.push({
        code: 'USE_NO_NODES',
        message: `use '${useId}' (${resolved.macro.ref}) has no nodes tagged with it; save the spec to materialise its nodes, or detach it`,
        useId,
      });
      continue;
    }
    let expansion: NodeMap;
    try {
      expansion = expandUse(useId, ref as MacroUse);
    } catch (err) {
      problems.push({
        code: 'USE_EXPAND_FAILED',
        message: err instanceof Error ? err.message : String(err),
        useId,
      });
      continue;
    }
    const taggedSet = new Set(tagged);
    const missing = Object.keys(expansion).filter((id) => !taggedSet.has(id));
    const extra = tagged.filter((id) => !Object.hasOwn(expansion, id));
    const changed = tagged.filter(
      (id) =>
        Object.hasOwn(expansion, id) && canonicalNode(nodes[id]) !== canonicalNode(expansion[id])
    );
    if (missing.length + extra.length + changed.length > 0) {
      const parts = [
        changed.length > 0 ? `changed: ${changed.join(', ')}` : '',
        missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
        extra.length > 0 ? `not in the expansion: ${extra.join(', ')}` : '',
      ].filter(Boolean);
      problems.push({
        code: 'USE_DRIFT',
        message: `use '${useId}' (${resolved.macro.ref}) has drifted from its expansion (${parts.join('; ')}); re-expand the use to regenerate its nodes, or detach it to keep the edits as hand-written nodes`,
        nodeId: changed[0] ?? extra[0],
        useId,
      });
    }
  }

  for (const [tag, ids] of byTag) {
    if (Object.hasOwn(uses, tag)) {
      continue;
    }
    for (const id of ids) {
      problems.push({
        code: 'USE_NOT_DECLARED',
        message: `node '${id}' is tagged with use '${tag}', which the spec's uses does not declare`,
        nodeId: id,
        useId: tag,
      });
    }
  }
  return problems;
}

/**
 * Every disagreement between a spec's `uses` and its flat nodes, as messages:
 * an invalid use id, an unknown macro or version, arguments the macro's schema
 * refuses, a node tagged with an undeclared use, a use with no tagged nodes, and
 * drift — a use whose tagged nodes are not (up to key order) the fresh expansion
 * of its arguments. Empty for a spec with no uses and no tags. Accepts a raw or a
 * parsed spec.
 */
export function findUseProblems(spec: SpecWithUses): string[] {
  return collectUseProblems(spec).map((p) => p.message);
}
