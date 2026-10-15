/**
 * Static, pre-execution validation of a {@link WorkflowSpec} — beyond the schema.
 *
 * `WorkflowSpecSchema` already checks the *shape* and that every edge reference
 * points to a real node. This catches the next class of "valid schema, broken
 * workflow" problems BEFORE a run (or before save), as structured findings:
 *
 *   errors (unrunnable graph — hard-gated in the generation repair loop):
 *     - EXPR_SYNTAX        a cond/binding expression doesn't parse in the safe
 *                          expression language (e.g. `===`, method calls, or a
 *                          malformed path like `nodes.foo[`)
 *     - NO_TERMINAL        no `terminate` node is reachable from `entry`
 *     - RESERVED_PATH_SEGMENT  a context write path (`storeAs`, a `set` key, a fan-out
 *                          `exports` entry, or a node id — results land at
 *                          `nodes.<id>.output`) contains `__proto__` / `prototype` /
 *                          `constructor`, which the interpreter refuses at run time
 *   warnings (advisory):
 *     - UNKNOWN_NODE_REF   a `{ from: "nodes.<id>..." }` binding names a node
 *                          that doesn't exist (may reference a not-yet-added node)
 *     - UNREACHABLE        a node can't be reached from `entry`
 *     - NODE_CANT_TERMINATE a reachable node has no path to any `terminate`
 *     - UNKNOWN_STEP       a `step` is not a built-in (may be a custom registry)
 *     - MISSING_CONFIG     a required step config field is absent
 *     - FANOUT_LEAK        a fan-out branch can walk into its own `join` node (or back into
 *                          the fan-out), so every branch would run what is meant to run once
 *     - SIGNAL_SHARED_ACROSS_BRANCHES  a `signal` node is reachable inside a fan-out whose
 *                          branches run concurrently (any `concurrency` but 1); they all wait
 *                          on the one name, and one delivery wakes exactly one branch
 *     - TERMINAL_IN_SUBGRAPH_ONLY  every reachable terminate sits inside a fan-out branch,
 *                          where a terminate ends one branch, not the run
 *     - IGNORED_FIELD      a node sets `retry` / `startToCloseTimeout` / `heartbeatTimeout`,
 *                          which the interpreter never reads (use `onFail: { retry }`); an
 *                          `eval` node sets `inputs`, a judge `baselineFrom` or a trajectory
 *                          `from`, which no scorer reads; or an `mcp` or `eval` node sets
 *                          `spanName`, which only an `agent` node's activity uses
 *     - GROUP_NOT_CONTIGUOUS  the edges between nodes sharing a `group` label do not join them
 *                          into one connected piece (edges are taken as undirected). It does NOT
 *                          check single entry or exit, and a group that is connected but also has a
 *                          path leaving and re-entering it passes
 *
 * Pure + I/O-free so it runs identically in the worker (pre-run / repair loop),
 * the gateway, and the web canvas (live lint). Wiring differs by caller: the
 * generation repair loop hard-gates on `errors`; the gateway SAVE path is
 * ADVISORY — it surfaces all findings (errors and warnings) as non-blocking
 * `warnings` so a work-in-progress draft is never rejected. DB-dependent ref
 * checks (agent/mcp existence, image allowlist) live elsewhere
 * (`validateSpecRefs`, shell gating) and compose on top.
 */

import { checkExprSyntax, RESERVED_SEGMENTS } from './expr.js';
import { type EvalScorer, type Node, nodeEdges, type WorkflowSpec } from './spec.js';
import { EXECUTOR_STEP_ALIASES, getStepMetadata, hasStep } from './stepRegistry.js';

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  nodeId?: string;
  field?: string;
  message: string;
}

export interface ValidationReport {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Target node ids of a node's outgoing edges (shared enumerator in spec.ts). */
function outgoingEdges(node: Node): string[] {
  return nodeEdges(node).map(([, target]) => target);
}

/** Every `{ field, binding }` carried by a node (for expr-lint + provenance). */
function nodeBindings(node: Node): Array<{ field: string; binding: unknown }> {
  const out: Array<{ field: string; binding: unknown }> = [];
  const addMap = (prefix: string, map: Record<string, unknown> | undefined) => {
    if (!map) {
      return;
    }
    for (const [k, v] of Object.entries(map)) {
      out.push({ binding: v, field: `${prefix}.${k}` });
    }
  };
  if ('inputs' in node) {
    addMap('inputs', node.inputs as Record<string, unknown> | undefined);
  }
  if (node.type === 'set') {
    addMap('values', node.values as Record<string, unknown>);
  }
  if (node.type === 'eval') {
    out.push({ binding: node.target, field: 'target' });
    // `candidateRef` is resolved by the interpreter like `target`, so the same
    // lint applies: a mistyped path or a malformed expression resolves to
    // undefined and the gate scorer silently falls back to the run's own branch.
    if (node.candidateRef) {
      out.push({ binding: node.candidateRef, field: 'candidateRef' });
    }
    // An assert scorer's `expr` is evaluated by the shared engine after the
    // runtime strips its `$.` path prefix (runEvalNode `evalAssert`), so lint
    // the same stripped text. The editor may hand us an unvalidated spec.
    const scorers: unknown[] = Array.isArray(node.scorers) ? node.scorers : [];
    scorers.forEach((entry, i) => {
      const s = entry as { kind?: unknown; expr?: unknown } | null;
      if (s && typeof s === 'object' && s.kind === 'assert' && typeof s.expr === 'string') {
        out.push({ binding: { expr: s.expr.replace(/\$\./g, '') }, field: `scorers[${i}].expr` });
      }
    });
  }
  if (node.type === 'humanApproval' && node.approverCount !== undefined) {
    out.push({ binding: node.approverCount, field: 'approverCount' });
  }
  if (node.type === 'fanOut') {
    out.push({ binding: node.over, field: 'over' });
  }
  if (node.type === 'terminate' && node.result) {
    addMap('result', node.result as Record<string, unknown>);
  }
  return out;
}

function isExprBinding(b: unknown): b is { expr: string } {
  return typeof b === 'object' && b !== null && typeof (b as { expr?: unknown }).expr === 'string';
}

function isFromBinding(b: unknown): b is { from: string } {
  return typeof b === 'object' && b !== null && typeof (b as { from?: unknown }).from === 'string';
}

/**
 * Does any existing node id "own" this `from` path? A path is `nodes.<id>[.…|[…]]`;
 * a node id may itself contain dots (NodeIdSchema allows arbitrary chars), so we
 * match by prefix rather than a narrow regex (which would false-positive on ids
 * with `.`/space/etc.). Returns false only when no node id is a prefix.
 */
function fromPathNamesKnownNode(from: string, nodeIds: Set<string>): boolean {
  const rest = from.slice('nodes.'.length);
  for (const id of nodeIds) {
    if (rest === id || rest.startsWith(`${id}.`) || rest.startsWith(`${id}[`)) {
      return true;
    }
  }
  return false;
}

/**
 * The context paths a node writes, with the field each comes from. Split the way
 * the interpreter's `setPath` splits them (on `.` only), so the check here
 * refuses exactly what a run would. Fan-out `exports` are read back with
 * `lookupPath`, which also understands brackets, so those split on both.
 */
function writePathSegments(id: string, node: Node): Array<{ field: string; segments: string[] }> {
  const out: Array<{ field: string; segments: string[] }> = [
    { field: 'id', segments: id.split('.') },
  ];
  if ('storeAs' in node && typeof node.storeAs === 'string') {
    out.push({ field: 'storeAs', segments: node.storeAs.split('.') });
  }
  if (node.type === 'set') {
    for (const key of Object.keys(node.values)) {
      out.push({ field: `values.${key}`, segments: key.split('.') });
    }
  }
  if (node.type === 'fanOut') {
    for (const p of node.exports ?? []) {
      out.push({ field: 'exports', segments: p.split(/[.[\]'"]+/) });
    }
  }
  return out;
}

/** Node fields the schema accepts for stored-spec compatibility but the interpreter never reads. */
const IGNORED_NODE_FIELDS = ['retry', 'startToCloseTimeout', 'heartbeatTimeout'] as const;

/**
 * Eval-node fields the schema accepts but no scorer reads: the executor scores
 * `target` alone (never the node's `inputs`), a judge has no baseline
 * comparison, and the trajectory scorer always reads the current run's traces.
 */
function ignoredEvalFields(id: string, node: Extract<Node, { type: 'eval' }>): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  // `inputs` are still resolved and recorded on the step row (and an expression
  // that throws fails the node), so only a non-empty map is worth a warning.
  if (node.inputs && Object.keys(node.inputs).length > 0) {
    out.push({
      code: 'IGNORED_FIELD',
      field: 'inputs',
      message:
        "'inputs' are resolved and recorded but no scorer reads them: an eval node scores only " +
        '`target`. Bind the value to score as `target`.',
      nodeId: id,
      severity: 'warning',
    });
  }
  // The editor lints a spec that may not have passed the schema yet (it reports
  // schema issues alongside), so a hand-edited `scorers` can be anything.
  const scorers: unknown[] = Array.isArray(node.scorers) ? node.scorers : [];
  scorers.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      return;
    }
    const scorer = entry as EvalScorer;
    if (scorer.kind === 'judge' && scorer.baselineFrom !== undefined) {
      out.push({
        code: 'IGNORED_FIELD',
        field: `scorers[${i}].baselineFrom`,
        message:
          "'baselineFrom' has no effect: the judge scores the target against its rubric alone " +
          'and makes no baseline comparison.',
        nodeId: id,
        severity: 'warning',
      });
    }
    if (scorer.kind === 'trajectory' && scorer.from !== undefined) {
      out.push({
        code: 'IGNORED_FIELD',
        field: `scorers[${i}].from`,
        message:
          "'from' has no effect: the trajectory scorer always reads this run's own agent traces.",
        nodeId: id,
        severity: 'warning',
      });
    }
  });
  return out;
}

export interface ValidateSpecOptions {
  /**
   * Permit steps flagged `internal` in the step registry. Only the platform's own
   * system template passes true; every authored, generated or bundled spec is
   * checked with the default and may not name one.
   */
  allowInternalSteps?: boolean;
}

/** Nodes of `spec` that name an internal step. */
export function findInternalSteps(spec: WorkflowSpec): Array<{ nodeId: string; step: string }> {
  const found: Array<{ nodeId: string; step: string }> = [];
  for (const [nodeId, node] of Object.entries(spec.nodes)) {
    if (node.type === 'step' && hasStep(node.step) && getStepMetadata(node.step).internal) {
      found.push({ nodeId, step: node.step });
    }
  }
  return found;
}

/**
 * The connected pieces of each `group` label, counting only edges between two
 * nodes that share the label (direction ignored). A group that is one piece is
 * "contiguous": folding it into one card does not stand a card in for members
 * with no edge between them. That is all this checks; it says nothing about how
 * many entries or exits the group has, and a connected group may still have a
 * path that leaves and re-enters it. Returns only the groups that fall apart,
 * each as its pieces.
 */
export function splitGroups(spec: WorkflowSpec): Map<string, string[][]> {
  const members = new Map<string, string[]>();
  for (const [id, node] of Object.entries(spec.nodes)) {
    // The schema trims on read; trimming again keeps a hand-built spec in agreement
    // with the web views, which group by the trimmed label.
    const group = node.group?.trim();
    if (group) {
      members.set(group, [...(members.get(group) ?? []), id]);
    }
  }
  const split = new Map<string, string[][]>();
  for (const [group, ids] of members) {
    const inGroup = new Set(ids);
    // Union-find over the group's own edges.
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) {
        root = parent.get(root) as string;
      }
      parent.set(id, root);
      return root;
    };
    for (const id of ids) {
      for (const [, target] of nodeEdges(spec.nodes[id] as Node)) {
        if (inGroup.has(target)) {
          parent.set(find(id), find(target));
        }
      }
    }
    const pieces = new Map<string, string[]>();
    for (const id of ids) {
      const root = find(id);
      pieces.set(root, [...(pieces.get(root) ?? []), id]);
    }
    if (pieces.size > 1) {
      split.set(group, [...pieces.values()]);
    }
  }
  return split;
}

export function validateSpec(
  spec: WorkflowSpec,
  options: ValidateSpecOptions = {}
): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodeIds = new Set(Object.keys(spec.nodes));

  if (!options.allowInternalSteps) {
    for (const { nodeId, step } of findInternalSteps(spec)) {
      errors.push({
        code: 'INTERNAL_STEP',
        field: 'step',
        message: `step '${step}' is internal to a platform template and cannot be used in an authored workflow`,
        nodeId,
        severity: 'error',
      });
    }
  }

  // ── Expression lint + binding provenance ──
  for (const [id, node] of Object.entries(spec.nodes)) {
    for (const field of IGNORED_NODE_FIELDS) {
      if ((node as Record<string, unknown>)[field] !== undefined) {
        warnings.push({
          code: 'IGNORED_FIELD',
          field,
          message:
            `'${field}' has no effect: activity retry and timeouts come from the worker's fixed ` +
            'proxy groups. Use `onFail: { retry: N }` for workflow-level retry.',
          nodeId: id,
          severity: 'warning',
        });
      }
    }
    if ((node.type === 'mcp' || node.type === 'eval') && node.spanName !== undefined) {
      warnings.push({
        code: 'IGNORED_FIELD',
        field: 'spanName',
        message:
          `'spanName' has no effect on ${node.type === 'mcp' ? 'an mcp' : 'an eval'} node: ` +
          "only an agent node's activity reads it.",
        nodeId: id,
        severity: 'warning',
      });
    }
    if (node.type === 'eval') {
      warnings.push(...ignoredEvalFields(id, node));
    }
    for (const { field, segments } of writePathSegments(id, node)) {
      const reserved = segments.find((seg) => RESERVED_SEGMENTS.has(seg));
      if (reserved !== undefined) {
        errors.push({
          code: 'RESERVED_PATH_SEGMENT',
          field,
          message: `'${reserved}' is a reserved path segment; the run refuses to write through it`,
          nodeId: id,
          severity: 'error',
        });
      }
    }
    if (node.type === 'cond') {
      const e = checkExprSyntax(node.expr);
      if (e) {
        errors.push({
          code: 'EXPR_SYNTAX',
          field: 'expr',
          message: e,
          nodeId: id,
          severity: 'error',
        });
      }
    }
    for (const { field, binding } of nodeBindings(node)) {
      if (isExprBinding(binding)) {
        const e = checkExprSyntax(binding.expr);
        if (e) {
          errors.push({ code: 'EXPR_SYNTAX', field, message: e, nodeId: id, severity: 'error' });
        }
      } else if (isFromBinding(binding) && binding.from.startsWith('nodes.')) {
        // `nodes.<id>.…` should name a real node. Advisory (warning), not an
        // error: dynamic shapes the linter can't model shouldn't block a save.
        if (!fromPathNamesKnownNode(binding.from, nodeIds)) {
          warnings.push({
            code: 'UNKNOWN_NODE_REF',
            field,
            message: `binding reads from a path under unknown node ('${binding.from}')`,
            nodeId: id,
            severity: 'warning',
          });
        }
      }
    }

    // ── Step existence + required config (warnings) ──
    if (node.type === 'step') {
      if (!hasStep(node.step)) {
        warnings.push({
          code: 'UNKNOWN_STEP',
          field: 'step',
          message: `'${node.step}' is not a built-in step`,
          nodeId: id,
          severity: 'warning',
        });
      } else {
        const typedNode = EXECUTOR_STEP_ALIASES[node.step];
        if (typedNode) {
          warnings.push({
            code: 'STEP_HAS_TYPED_NODE',
            field: 'step',
            message: `'${node.step}' is the executor behind the \`${typedNode}\` node; author the node instead, so its settings have a form and its fields are checked`,
            nodeId: id,
            severity: 'warning',
          });
        }
        const meta = getStepMetadata(node.step);
        const config = (node.config ?? {}) as Record<string, unknown>;
        const inputs = (node.inputs ?? {}) as Record<string, unknown>;
        for (const f of meta.configFields) {
          if (f.required && config[f.key] === undefined && inputs[f.key] === undefined) {
            warnings.push({
              code: 'MISSING_CONFIG',
              field: `config.${f.key}`,
              message: `step '${node.step}' is missing required config '${f.key}'`,
              nodeId: id,
              severity: 'warning',
            });
          }
        }
      }
    }
  }

  // ── Reachability from entry ──
  const reachable = new Set<string>();
  const queue: string[] = spec.nodes[spec.entry] ? [spec.entry] : [];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (reachable.has(cur)) {
      continue;
    }
    reachable.add(cur);
    for (const next of outgoingEdges(spec.nodes[cur] as Node)) {
      if (nodeIds.has(next) && !reachable.has(next)) {
        queue.push(next);
      }
    }
  }
  for (const id of nodeIds) {
    if (!reachable.has(id)) {
      warnings.push({
        code: 'UNREACHABLE',
        message: `node '${id}' is not reachable from the entry node`,
        nodeId: id,
        severity: 'warning',
      });
    }
  }

  // ── Fan-out closure ──
  // The interpreter walks a branch from `subgraph` until a node ends it, over the
  // same flat node map as the main flow, so nothing but the edges keeps the two
  // apart. A branch that can reach its own `join` runs the post-join nodes once per
  // branch; one that reaches its own fan-out recurses.
  const reachableFrom = (start: string, skipSubgraph: boolean): Set<string> => {
    const seen = new Set<string>();
    const stack = nodeIds.has(start) ? [start] : [];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) {
        continue;
      }
      seen.add(cur);
      for (const [field, target] of nodeEdges(spec.nodes[cur] as Node)) {
        if (skipSubgraph && field === 'subgraph') {
          continue;
        }
        if (nodeIds.has(target)) {
          stack.push(target);
        }
      }
    }
    return seen;
  };
  const sharedSignalWarned = new Set<string>();
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.type !== 'fanOut') {
      continue;
    }
    const inBranch = reachableFrom(node.subgraph, false);
    if (inBranch.has(node.join) || inBranch.has(id)) {
      warnings.push({
        code: 'FANOUT_LEAK',
        field: 'subgraph',
        message: inBranch.has(id)
          ? `a branch of fan-out '${id}' can reach the fan-out itself`
          : `a branch of fan-out '${id}' can reach its join node '${node.join}'; branches should end instead of continuing into it`,
        nodeId: id,
        severity: 'warning',
      });
    }
    // A `signal` node keeps its fixed name inside a branch — external senders
    // address it by that name — so concurrent branches all wait on one slot,
    // and one delivery is consumed by exactly one of them.
    if (node.concurrency === undefined || node.concurrency > 1) {
      for (const branchNodeId of inBranch) {
        const branchNode = spec.nodes[branchNodeId] as Node;
        if (branchNode.type !== 'signal' || sharedSignalWarned.has(branchNodeId)) {
          continue;
        }
        sharedSignalWarned.add(branchNodeId);
        warnings.push({
          code: 'SIGNAL_SHARED_ACROSS_BRANCHES',
          field: 'name',
          message: `signal node '${branchNodeId}' waits on '${branchNode.name}' inside fan-out '${id}', whose branches run concurrently; every branch waits on the same signal, and one delivery wakes only one branch — the others keep waiting for a delivery of their own or their timeout (set concurrency to 1 to wait branch by branch)`,
          nodeId: branchNodeId,
          severity: 'warning',
        });
      }
    }
  }

  // ── Termination: at least one terminate reachable; flag nodes that can't reach one ──
  const terminals = [...nodeIds].filter((id) => (spec.nodes[id] as Node).type === 'terminate');
  const reachableTerminals = terminals.filter((id) => reachable.has(id));
  if (reachableTerminals.length === 0) {
    errors.push({
      code: 'NO_TERMINAL',
      message: 'no terminate node is reachable from the entry node',
      severity: 'error',
    });
  } else {
    const mainFlow = reachableFrom(spec.entry, true);
    if (!reachableTerminals.some((t) => mainFlow.has(t))) {
      warnings.push({
        code: 'TERMINAL_IN_SUBGRAPH_ONLY',
        message:
          'every reachable terminate node sits inside a fan-out branch, where it ends one branch rather than the run',
        severity: 'warning',
      });
    }
    // Reverse-reachability: which nodes can reach SOME terminate?
    const canTerminate = new Set<string>(terminals);
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of nodeIds) {
        if (canTerminate.has(id)) {
          continue;
        }
        if (outgoingEdges(spec.nodes[id] as Node).some((e) => canTerminate.has(e))) {
          canTerminate.add(id);
          changed = true;
        }
      }
    }
    for (const id of reachable) {
      if (!canTerminate.has(id)) {
        warnings.push({
          code: 'NODE_CANT_TERMINATE',
          message: `node '${id}' has no path to a terminate node (possible infinite loop)`,
          nodeId: id,
          severity: 'warning',
        });
      }
    }
  }

  for (const [group, pieces] of splitGroups(spec)) {
    warnings.push({
      code: 'GROUP_NOT_CONTIGUOUS',
      field: 'group',
      message: `group '${group}' is split into ${pieces.length} disconnected pieces (${pieces
        .map((p) => p.join(', '))
        .join(' | ')}); a folded view would hide the path between them`,
      nodeId: pieces[1]?.[0],
      severity: 'warning',
    });
  }

  return { errors, warnings };
}

/** One issue as a human-readable line: `nodeId.field: message` (parts omitted when absent). */
export function formatValidationIssue(issue: ValidationIssue): string {
  if (!issue.nodeId) {
    return issue.message;
  }
  return `${issue.nodeId}${issue.field ? `.${issue.field}` : ''}: ${issue.message}`;
}

/** Format a report's errors into a single human-readable string (for thrown errors / API messages). */
export function formatValidationErrors(report: ValidationReport): string {
  return report.errors.map(formatValidationIssue).join('; ');
}
