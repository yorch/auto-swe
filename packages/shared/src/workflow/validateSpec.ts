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
 *   warnings (advisory):
 *     - UNKNOWN_NODE_REF   a `{ from: "nodes.<id>..." }` binding names a node
 *                          that doesn't exist (may reference a not-yet-added node)
 *     - UNREACHABLE        a node can't be reached from `entry`
 *     - NODE_CANT_TERMINATE a reachable node has no path to any `terminate`
 *     - UNKNOWN_STEP       a `step` is not a built-in (may be a custom registry)
 *     - MISSING_CONFIG     a required step config field is absent
 *
 * Pure + I/O-free so it runs identically in the worker (pre-run / repair loop),
 * the gateway, and the web canvas (live lint). Wiring differs by caller: the
 * generation repair loop hard-gates on `errors`; the gateway SAVE path is
 * ADVISORY — it surfaces all findings (errors and warnings) as non-blocking
 * `warnings` so a work-in-progress draft is never rejected. DB-dependent ref
 * checks (agent/mcp existence, image allowlist) live elsewhere
 * (`validateSpecRefs`, shell gating) and compose on top.
 */

import { checkExprSyntax } from './expr.js';
import { type Node, nodeEdges, type WorkflowSpec } from './spec.js';
import { getStepMetadata, hasStep } from './stepRegistry.js';

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

export function validateSpec(spec: WorkflowSpec): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodeIds = new Set(Object.keys(spec.nodes));

  // ── Expression lint + binding provenance ──
  for (const [id, node] of Object.entries(spec.nodes)) {
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
