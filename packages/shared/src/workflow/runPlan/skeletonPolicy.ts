/**
 * Skeleton policy for generated run plans.
 *
 * A generated plan is a mandatory skeleton plus a free middle. The policy pins the skeleton's
 * BEHAVIOUR, not its presence: a node named `runReviewNetwork` proves nothing when it carries a
 * replacement `systemPrompt`, warns instead of blocking, is fed a different change than the one the
 * pull request ships, or can be routed around. It has two halves:
 *
 * - {@link checkSkeletonPolicy} is pure and read-only. It runs at generation (as the repair loop's
 *   hard gate), again at approval, and again in the worker before the spec is pinned. It never
 *   rewrites anything.
 * - {@link applySkeletonPolicy} is the generation-time half. It inserts the mandatory nodes that are
 *   plainly absent, then runs the check. It must not be called at approval: an approved spec is
 *   never silently rewritten.
 *
 * What the check enforces, for a `delivering` plan (mandatory stages: implementation, review,
 * pull request, human merge wait, and quality gates when the plan has any):
 *
 * - **Configuration and inputs.** Every use of a free or skeleton step carries only allowlisted
 *   `config` keys with allowlisted values, and only allowlisted `inputs` keys, each bound with a
 *   `from` path to a source the platform wrote (`skeletonBindings.ts`). No `literal` or `expr`
 *   reaches a security-relevant input. No authored command or container code anywhere.
 * - **Writes.** A `set` node or a `storeAs` writes only under `context.`; the platform's own
 *   plumbing paths take only a node's output, and `context.currentCodeResult` only an
 *   implementation or fix step's. `nodes.*` is never written, so a plan cannot answer its own cond.
 * - **Failure policy.** A stage or fix node's `onFail` is `block` or a bounded retry, never `warn`,
 *   and its `onError` is never `continue`.
 * - **Ordering by dominance.** The graph is modelled the way the interpreter walks it: every node
 *   is an entry vertex and a PASSED vertex, and `next`, `onTrue`, `onApprove`, `onReceive` leave
 *   from PASSED while `onFailure`, `onExhausted` (the node does NOT run on that entry), `onTimeout`,
 *   `onReject` and a `warn`/`continue` fall-through leave from entry. Every path from the entry to a
 *   node of a later stage passes through the PASSED vertex of a node of the earlier stage
 *   (implementation, then review, then gates, then the pull request, then the merge wait), and
 *   every path to a `SUCCESS` ending passes through the merge wait having RECEIVED its signal: a
 *   timeout, an exhaustion or a failure route out of the wait cannot end SUCCESS.
 * - **Code does not change after a check.** From every node that changes code (the implementation
 *   and the three fix steps) no path reaches the pull request, the merge wait or a SUCCESS ending
 *   without passing a re-review, and a re-gate when the plan has gates. A gate fix needs only the
 *   re-gate.
 * - **Verdicts.** A review node's rejection cannot reach the pull request: its only way on is the
 *   approving branch of a `cond` on `nodes.<id>.output.approved`.
 * - **Loops.** Every cycle contains a node with `maxVisits` and `onExhausted`.
 *
 * For an `output-only` (library-agent) plan: at least one `agent` node, a human review after an
 * agent on every path to `SUCCESS` (a `humanApproval`, or a `humanReview` whose content is that
 * agent's output; a `humanDecision` cannot say approve or reject, so it never counts), and a
 * reachable `terminate`.
 *
 * The flat `nodes` are the only thing read. Macro metadata (`uses`, a node's `use` tag) is never
 * trusted to say what a node is; it is only checked for drift against its expansion.
 *
 * Pure and I/O-free. It cannot check the requester's launchable agent set, which needs the
 * database; the caller adds that.
 */

import { NON_LAUNCHABLE_AGENT_KEYS } from '../../lib/agentRun.js';
import { isAuthoredCommandNode, isContainerCodeNode } from '../containerCode.js';
import { collectUseProblems } from '../macros.js';
import { type Node, nodeEdges, setNodeEdge, type WorkflowSpec } from '../spec.js';
import {
  buildCanonicalCore,
  buildValidatePhase,
  CORE_ENTRY,
  CORE_GUIDANCE_SLOT,
  VALIDATE_ENTRY,
} from './canonicalCore.js';
import { type CoreRegions, checkCanonicalCore, writesPlanNotes } from './coreCheck.js';
import {
  bindingKind,
  CODE_CHANGING_STEPS,
  freeStatusRefusal,
  hasConfigAllowlist,
  inputBindingProblem,
  isSafePath,
  isTerminalStatusWord,
  nodeOutputId,
  STEP_CONFIG_ALLOWLIST,
  type ValueRule,
  valueMatches,
  wholeOutputId,
  writeRefusal,
} from './skeletonBindings.js';
import {
  classifyRunPlanStep,
  runPlanNodeTypeRefusal,
  runPlanStepRefusal,
  type SkeletonMode,
} from './stepAllowlist.js';

export type { SkeletonMode } from './stepAllowlist.js';

export type SkeletonSeverity = 'error' | 'warning';

export interface SkeletonIssue {
  code: string;
  severity: SkeletonSeverity;
  nodeId?: string;
  message: string;
}

/** The mandatory stages of a delivering plan, in required order. */
export const DELIVERING_STAGES = [
  'implementation',
  'review',
  'qualityGates',
  'pullRequest',
  'mergeWait',
] as const;
export type DeliveringStage = (typeof DELIVERING_STAGES)[number];

export interface SkeletonReport {
  mode: SkeletonMode;
  /** True when there is no error. Warnings do not block. */
  ok: boolean;
  errors: SkeletonIssue[];
  warnings: SkeletonIssue[];
  /** Every issue, errors first as found. */
  issues: SkeletonIssue[];
  /**
   * The nodes that fill each mandatory stage (delivering: {@link DELIVERING_STAGES}; output-only:
   * `agent` and `humanReview`), for a preview that marks them.
   */
  mandatory: Record<string, string[]>;
  /**
   * Delivering plans: where each node sits, for a preview that marks the pinned core and shows the
   * generator's pre-region and post-merge nodes as free. Absent in an output-only plan.
   */
  regions?: CoreRegions;
}

/** The signal the human merge wait listens on. */
export const MERGE_WAIT_SIGNAL = 'humanMergeSignal';

const IMPLEMENTATION_STEP = 'executeImplementation';
const REVIEW_STEP = 'runReviewNetwork';
const PULL_REQUEST_STEP = 'createOrUpdatePullRequest';
const GATE_FIX_STEP = 'executeGateFixImplementation';
const GATE_STEPS: ReadonlySet<string> = new Set([
  'runBuild',
  'runLint',
  'runQualityGates',
  'runTests',
  'runTypecheck',
  'runVulnScan',
]);

// ── Graph model ──
//
// Every node is two vertices. `in:<id>` is "the walk entered the node"; `ok:<id>` is "the node ran
// and passed". The interpreter routes from one or the other:
//
// - `next`, `onTrue`/`onFalse`, `onReceive`, `onApprove`, `onSubmit`, a decision option: from `ok:`.
// - `onFailure`, `onExhausted` (the entry that exceeds `maxVisits` is routed WITHOUT running the
//   node), `onTimeout`, `onReject`, `onRequestChanges`, and the fall-through of `onFail: warn` or
//   `onError: continue` (the node failed and the walk goes on): from `in:`.
//
// "Passes through a stage" is then a cut over the stage's `ok:` vertices. A route out of a node by
// failure, exhaustion or timeout skips its `ok:` vertex, so it does not count as having passed.

interface Edge {
  from: string;
  to: string;
  field: string;
}

const inV = (id: string): string => `in:${id}`;
const okV = (id: string): string => `ok:${id}`;
const nodeOfVertex = (v: string): string | undefined =>
  v.startsWith('in:') || v.startsWith('ok:') ? v.slice(3) : undefined;

/** Edge fields that leave a node without it having passed. */
const NOT_PASSED_FIELDS: ReadonlySet<string> = new Set([
  'join',
  'onExhausted',
  'onFailure',
  'onReject',
  'onRequestChanges',
  'onTimeout',
  'subgraph',
]);

/** Edge fields that are a failure, exhaustion, timeout or rejection route. */
const FAILURE_FIELDS: ReadonlySet<string> = new Set([
  'next (onError: continue)',
  'next (onFail: warn)',
  'onExhausted',
  'onFailure',
  'onReject',
  'onRequestChanges',
  'onTimeout',
]);

/** Node types dispatched as an activity: they carry `onFail` and `onError`. */
function isDispatchNode(node: Node): boolean {
  switch (node.type) {
    case 'step':
    case 'agent':
    case 'mcp':
    case 'eval':
    case 'shell':
    case 'containerStep':
      return true;
    default:
      return false;
  }
}

/** A node that ends the run when it has no `next`: the interpreter reads "no next" as `SUCCESS`. */
function endsWithoutNext(node: Node): boolean {
  return (
    (isDispatchNode(node) || node.type === 'set') && (node as { next?: string }).next === undefined
  );
}

function routesToSuccess(route: unknown): boolean {
  return (
    typeof route === 'object' &&
    route !== null &&
    (route as { status?: unknown }).status === 'SUCCESS'
  );
}

interface Graph {
  entry: string;
  adj: Map<string, Edge[]>;
  /** The same graph with a node's two vertices merged, for cycle detection. */
  nodeAdj: Map<string, Set<string>>;
  /** Real `SUCCESS` terminate vertices plus the virtual endings below. */
  successTerminals: Set<string>;
  /** Every vertex reachable from the entry, virtual endings included. */
  reachable: Set<string>;
  /** Virtual endings: `success@<node>:<field>`. */
  virtual: Set<string>;
}

function buildGraph(spec: WorkflowSpec): Graph {
  const adj = new Map<string, Edge[]>();
  const nodeAdj = new Map<string, Set<string>>();
  const successTerminals = new Set<string>();
  const virtual = new Set<string>();
  const push = (edge: Edge): void => {
    const list = adj.get(edge.from) ?? [];
    list.push(edge);
    adj.set(edge.from, list);
    const a = nodeOfVertex(edge.from);
    const b = nodeOfVertex(edge.to);
    if (a !== undefined && b !== undefined && a !== b) {
      const set = nodeAdj.get(a) ?? new Set<string>();
      set.add(b);
      nodeAdj.set(a, set);
    } else if (a !== undefined && a === b && edge.field !== 'ok') {
      const set = nodeAdj.get(a) ?? new Set<string>();
      set.add(b);
      nodeAdj.set(a, set);
    }
  };
  for (const [id, node] of Object.entries(spec.nodes)) {
    push({ field: 'ok', from: inV(id), to: okV(id) });
    for (const [field, to] of nodeEdges(node)) {
      if (Object.hasOwn(spec.nodes, to)) {
        push({
          field,
          from: NOT_PASSED_FIELDS.has(field) ? inV(id) : okV(id),
          to: inV(to),
        });
      }
    }
    const addVirtual = (from: string, field: string): void => {
      const v = `success@${id}:${field}`;
      virtual.add(v);
      successTerminals.add(v);
      push({ field, from, to: v });
    };
    if (node.type === 'terminate' && node.status === 'SUCCESS') {
      successTerminals.add(inV(id));
    }
    if ('onFailure' in node && routesToSuccess(node.onFailure)) {
      addVirtual(inV(id), 'onFailure');
    }
    if (node.maxVisits !== undefined && routesToSuccess(node.onExhausted)) {
      addVirtual(inV(id), 'onExhausted');
    }
    if (endsWithoutNext(node)) {
      addVirtual(okV(id), 'next (no next: the run ends SUCCESS)');
    }
    // A failure the node's own policy swallows: the walk goes on as if it had passed.
    if (isDispatchNode(node)) {
      const failOn = node as { onFail?: unknown; onError?: unknown; next?: string };
      const swallow: string[] = [];
      if (failOn.onFail === 'warn') {
        swallow.push('next (onFail: warn)');
      }
      if (failOn.onError === 'continue') {
        swallow.push('next (onError: continue)');
      }
      for (const field of swallow) {
        if (failOn.next !== undefined && Object.hasOwn(spec.nodes, failOn.next)) {
          push({ field, from: inV(id), to: inV(failOn.next) });
        } else if (failOn.next === undefined) {
          addVirtual(inV(id), field);
        }
      }
    }
  }
  const reachable = new Set<string>();
  const stack: string[] = Object.hasOwn(spec.nodes, spec.entry) ? [inV(spec.entry)] : [];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (reachable.has(cur)) {
      continue;
    }
    reachable.add(cur);
    for (const e of adj.get(cur) ?? []) {
      stack.push(e.to);
    }
  }
  return { adj, entry: inV(spec.entry), nodeAdj, reachable, successTerminals, virtual };
}

/**
 * A path from `start` (default: the entry) to `target` that avoids every vertex in `blocked`, or
 * `undefined` when the blocked set cuts every path.
 */
function pathAvoiding(
  graph: Graph,
  blocked: ReadonlySet<string>,
  target: string,
  start: string = graph.entry,
  skipEdge?: (edge: Edge) => boolean
): Edge[] | undefined {
  if (blocked.has(start)) {
    return undefined;
  }
  if (start === target) {
    return [];
  }
  const parent = new Map<string, Edge>();
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const e of graph.adj.get(cur) ?? []) {
      if (seen.has(e.to) || blocked.has(e.to) || skipEdge?.(e)) {
        continue;
      }
      seen.add(e.to);
      parent.set(e.to, e);
      if (e.to === target) {
        const path: Edge[] = [];
        let at = target;
        while (at !== start) {
          const edge = parent.get(at) as Edge;
          path.unshift(edge);
          at = edge.from;
        }
        return path;
      }
      queue.push(e.to);
    }
  }
  return undefined;
}

function describePath(path: Edge[], start: string): string {
  const parts = [start];
  for (const e of path) {
    if (e.to.startsWith('ok:')) {
      continue;
    }
    const to = e.to.startsWith('success@') ? 'SUCCESS' : (nodeOfVertex(e.to) ?? e.to);
    parts.push(`${to} (${e.field})`);
  }
  return parts.join(' -> ');
}

/**
 * Which kind of edge a bypass path leans on. The skip edge is the first edge `u -> v` on the path
 * where `u` can still reach the blocked stage and `v` no longer can: that is where the path leaves
 * the legitimate flow. A failure, exhaustion or timeout route there, or a `cond`, names the bypass;
 * any other edge, or none (the stage was never on the way), reports the fallback code.
 */
function bypassCode(
  path: Edge[],
  graph: Graph,
  blocked: ReadonlySet<string>,
  spec: WorkflowSpec,
  fallback: string
): string {
  const reverse = new Map<string, string[]>();
  for (const edges of graph.adj.values()) {
    for (const e of edges) {
      reverse.set(e.to, [...(reverse.get(e.to) ?? []), e.from]);
    }
  }
  const canReach = new Set<string>(blocked);
  const stack = [...blocked];
  while (stack.length > 0) {
    for (const from of reverse.get(stack.pop() as string) ?? []) {
      if (!canReach.has(from)) {
        canReach.add(from);
        stack.push(from);
      }
    }
  }
  const skip = path.find((e) => canReach.has(e.from) && !canReach.has(e.to));
  if (skip === undefined) {
    return fallback;
  }
  if (FAILURE_FIELDS.has(skip.field)) {
    return 'FAILURE_ROUTE_BYPASS';
  }
  const from = nodeOfVertex(skip.from);
  return from !== undefined && spec.nodes[from]?.type === 'cond' ? 'COND_BYPASS' : fallback;
}

/** A node on a cycle in which no node sets both `maxVisits` and `onExhausted`, if there is one. */
function findUnboundedCycleNode(spec: WorkflowSpec, graph: Graph): string | undefined {
  const bounded = (id: string): boolean => {
    const n = spec.nodes[id];
    return n !== undefined && n.maxVisits !== undefined && n.onExhausted !== undefined;
  };
  const color = new Map<string, 1 | 2>();
  let found: string | undefined;
  const visit = (id: string): void => {
    if (found !== undefined || bounded(id) || color.get(id) === 2) {
      return;
    }
    color.set(id, 1);
    for (const to of graph.nodeAdj.get(id) ?? []) {
      if (bounded(to)) {
        continue;
      }
      if (color.get(to) === 1) {
        found = to;
        return;
      }
      if (!color.has(to)) {
        visit(to);
        if (found !== undefined) {
          return;
        }
      }
    }
    color.set(id, 2);
  };
  for (const id of Object.keys(spec.nodes)) {
    if (graph.reachable.has(inV(id))) {
      visit(id);
    }
    if (found !== undefined) {
      break;
    }
  }
  return found;
}

// ── Node classification ──

function stepName(node: Node): string | undefined {
  return node.type === 'step' ? node.step : undefined;
}

function stageOf(node: Node): DeliveringStage | undefined {
  if (node.type === 'signal') {
    return node.name === MERGE_WAIT_SIGNAL ? 'mergeWait' : undefined;
  }
  const step = stepName(node);
  if (step === undefined) {
    return undefined;
  }
  if (step === IMPLEMENTATION_STEP) {
    return 'implementation';
  }
  if (step === REVIEW_STEP) {
    return 'review';
  }
  if (step === PULL_REQUEST_STEP) {
    return 'pullRequest';
  }
  return GATE_STEPS.has(step) ? 'qualityGates' : undefined;
}

/** Whether a node changes the code in the run's checkout. */
function changesCode(node: Node): boolean {
  return node.type === 'step' && CODE_CHANGING_STEPS.has(node.step);
}

function isHumanReviewType(node: Node): boolean {
  return (
    node.type === 'humanReview' || node.type === 'humanApproval' || node.type === 'humanDecision'
  );
}

function agentKey(agentRef: string): string {
  return agentRef.split('@')[0] ?? agentRef;
}

// ── The check ──

/** A node id a generated plan may use: no '.', '[' or ']', which the context writer splits on. */
export const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED_NODE_IDS: ReadonlySet<string> = new Set(['constructor', 'prototype']);

/**
 * The full policy. For a delivering plan: the structural layer ({@link checkGraphPolicy}) AND the
 * canonical-core layer (`coreCheck.ts`): the core must equal the shipped one, and the free ends
 * must stay in their regions. An output-only plan has no core, so it is the structural layer.
 */
export function checkSkeletonPolicy(spec: WorkflowSpec, mode: SkeletonMode): SkeletonReport {
  const graph = checkGraphPolicy(spec, mode);
  if (mode !== 'delivering') {
    return graph;
  }
  const core = checkCanonicalCore(spec);
  const extra: SkeletonIssue[] = core.issues.map((i) => ({
    code: i.code,
    message: i.message,
    severity: 'error',
    ...(i.nodeId !== undefined ? { nodeId: i.nodeId } : {}),
  }));
  return {
    ...buildReport(mode, [...graph.issues, ...extra], graph.mandatory),
    regions: core.regions,
  };
}

/**
 * The structural layer: allowlists for steps, nodes, config and inputs, write rules, failure
 * policy, dominance over the graph, code-after-check, verdicts and loops. It runs over every node
 * of a plan, free and core alike. Exported for the tests that exercise it on graphs that are not the
 * canonical core; a caller that decides whether a plan may run uses {@link checkSkeletonPolicy}.
 */
export function checkGraphPolicy(spec: WorkflowSpec, mode: SkeletonMode): SkeletonReport {
  const issues: SkeletonIssue[] = [];
  const add = (
    code: string,
    message: string,
    nodeId?: string,
    severity: SkeletonSeverity = 'error'
  ): void => {
    issues.push({ code, message, severity, ...(nodeId !== undefined ? { nodeId } : {}) });
  };

  // Macro metadata is only trusted to agree with the flat nodes.
  for (const problem of collectUseProblems(spec)) {
    add(problem.code, problem.message, problem.nodeId, 'error');
  }

  const nodes = Object.entries(spec.nodes);
  checkNodes(spec, mode, nodes, add);

  const graph = buildGraph(spec);
  const isReachable = (id: string): boolean => graph.reachable.has(inV(id));
  const stages = new Map<DeliveringStage, string[]>();
  for (const stage of DELIVERING_STAGES) {
    stages.set(stage, []);
  }
  for (const [id, node] of nodes) {
    const stage = stageOf(node);
    if (stage !== undefined && isReachable(id)) {
      (stages.get(stage) as string[]).push(id);
    }
  }
  const agentNodes = nodes.filter(([id, n]) => n.type === 'agent' && isReachable(id));
  const humanReviewNodes = nodes.filter(([id, n]) => isHumanReviewType(n) && isReachable(id));

  // Termination and loops hold for both modes.
  const reachableTerminates = nodes.filter(([id, n]) => n.type === 'terminate' && isReachable(id));
  if (reachableTerminates.length === 0 && graph.successTerminals.size === 0) {
    add('NO_TERMINATE', 'no terminate node is reachable from the entry node');
  } else if (![...graph.successTerminals].some((t) => graph.reachable.has(t))) {
    add(
      'NO_SUCCESS_TERMINAL',
      'no path from the entry ends the run with SUCCESS, so the plan can never complete'
    );
  }
  const cycleNode = findUnboundedCycleNode(spec, graph);
  if (cycleNode !== undefined) {
    add(
      'LOOP_UNBOUNDED',
      `node '${cycleNode}' is on a loop in which no node sets both maxVisits and onExhausted`,
      cycleNode
    );
  }

  const reachableSuccess = [...graph.successTerminals].filter((t) => graph.reachable.has(t));

  const mandatory: Record<string, string[]> = {};
  if (mode === 'delivering') {
    for (const stage of DELIVERING_STAGES) {
      mandatory[stage] = stages.get(stage) as string[];
    }
    checkDelivering(spec, graph, stages, reachableSuccess, add);
  } else {
    mandatory.agent = agentNodes.map(([id]) => id);
    mandatory.humanReview = humanReviewNodes.map(([id]) => id);
    checkOutputOnly(spec, graph, agentNodes, humanReviewNodes, reachableSuccess, add);
  }

  return buildReport(mode, issues, mandatory);
}

function buildReport(
  mode: SkeletonMode,
  issues: SkeletonIssue[],
  mandatory: Record<string, string[]>
): SkeletonReport {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { errors, issues, mandatory, mode, ok: errors.length === 0, warnings };
}

type Add = (code: string, message: string, nodeId?: string, severity?: SkeletonSeverity) => void;

/** The vertex of a success ending, as the node it belongs to. */
function endingNode(terminal: string): string | undefined {
  if (terminal.startsWith('success@')) {
    return terminal.slice('success@'.length).split(':')[0];
  }
  return nodeOfVertex(terminal);
}

function checkNodes(
  spec: WorkflowSpec,
  mode: SkeletonMode,
  nodes: Array<[string, Node]>,
  add: Add
): void {
  for (const [id, node] of nodes) {
    if (!NODE_ID_PATTERN.test(id) || RESERVED_NODE_IDS.has(id)) {
      add(
        'NODE_ID_INVALID',
        `node id '${id}' is not a plain identifier (letters, digits, '_' and '-', starting with a letter); a '.' or bracket in an id lets a node write another node's output`,
        id
      );
    }
    if (isContainerCodeNode(node)) {
      add('CONTAINER_CODE', `node '${id}' runs container code, which a generated plan may not`, id);
    } else {
      const typeRefusal = runPlanNodeTypeRefusal(node);
      if (typeRefusal !== undefined) {
        add('NODE_TYPE_DENIED', `node '${id}': ${typeRefusal}`, id);
      }
    }
    if (isAuthoredCommandNode(node)) {
      add(
        'AUTHORED_COMMAND',
        `node '${id}' runs a command written into the plan, which a generated plan may not`,
        id
      );
    }
    if (
      node.type !== 'terminate' &&
      node.status !== undefined &&
      isTerminalStatusWord(node.status)
    ) {
      add(
        'STATUS_TERMINAL',
        `node '${id}' stamps the status '${node.status}', the vocabulary that ends a run`,
        id
      );
    }
    if (mode === 'output-only' && node.type !== 'terminate' && node.status !== undefined) {
      const refusal = freeStatusRefusal(node.status);
      if (refusal !== undefined) {
        add('FREE_STATUS_DENIED', `node '${id}' ${refusal}`, id);
      }
    }
    checkWrites(spec, id, node, add);
    if (node.type === 'agent') {
      const key = agentKey(node.agentRef);
      if (NON_LAUNCHABLE_AGENT_KEYS.has(key)) {
        add(
          'NON_LAUNCHABLE_AGENT',
          `agent node '${id}' names '${key}', which backs a platform mechanism and cannot be launched`,
          id
        );
      }
      if (node.systemPrompt !== undefined) {
        add(
          'AGENT_SYSTEM_PROMPT',
          `agent node '${id}' replaces the agent's system prompt, which a generated plan may not`,
          id
        );
      }
      if (mode === 'output-only') {
        if (node.onFail === 'warn') {
          add('ONFAIL_WARN', `agent node '${id}' continues after a failure (onFail: warn)`, id);
        }
        if (node.onError === 'continue') {
          add('ONERROR_CONTINUE', `agent node '${id}' swallows errors (onError: continue)`, id);
        }
      }
    }
    if (node.type !== 'step') {
      continue;
    }
    const cls = classifyRunPlanStep(node.step);
    const refusal = runPlanStepRefusal(node.step, mode);
    if (refusal !== undefined && !isContainerCodeNode(node)) {
      add(
        cls === 'denied'
          ? 'STEP_DENIED'
          : cls === 'skeleton'
            ? 'STEP_DELIVERING_ONLY'
            : 'STEP_NOT_ALLOWLISTED',
        `node '${id}': ${refusal}`,
        id
      );
    }
    if (cls === 'skeleton' || cls === 'free') {
      checkStepBindings(id, node, add);
    }
    if (stageOf(node) !== undefined || changesCode(node)) {
      if (node.onFail === 'warn') {
        add(
          'ONFAIL_WARN',
          `node '${id}' (${node.step}) continues after a failure (onFail: warn); a mandatory or code-changing node must block`,
          id
        );
      }
      if (node.onError === 'continue') {
        add(
          'ONERROR_CONTINUE',
          `node '${id}' (${node.step}) swallows errors (onError: continue); a mandatory or code-changing node must fail the run`,
          id
        );
      }
    }
  }
}

/** Every context write the node makes: a `set`'s values, and any `storeAs`. */
function checkWrites(spec: WorkflowSpec, id: string, node: Node, add: Add): void {
  if (node.type === 'set') {
    for (const [path, binding] of Object.entries(node.values)) {
      const problem = writeRefusal(path, { binding, kind: 'set' }, spec);
      if (problem) {
        add(problem.code, `set node '${id}' ${problem.message}`, id);
      }
    }
  }
  const storeAs = 'storeAs' in node ? node.storeAs : undefined;
  if (storeAs !== undefined) {
    const problem = writeRefusal(storeAs, { kind: 'storeAs', node }, spec);
    if (problem) {
      add(problem.code, `node '${id}' ${problem.message}`, id);
    }
  }
}

function checkStepBindings(id: string, node: Extract<Node, { type: 'step' }>, add: Add): void {
  const allowed: Readonly<Record<string, ValueRule>> = hasConfigAllowlist(node.step)
    ? (STEP_CONFIG_ALLOWLIST[node.step] as Readonly<Record<string, ValueRule>>)
    : {};
  for (const [key, value] of Object.entries(node.config ?? {})) {
    if (FORBIDDEN_CONFIG_KEYS.has(key)) {
      add(
        'OVERRIDE_FORBIDDEN',
        `node '${id}' (${node.step}) sets config '${key}', which overrides the platform's behaviour`,
        id
      );
    } else if (!Object.hasOwn(allowed, key)) {
      add('CONFIG_KEY_NOT_ALLOWED', `node '${id}' (${node.step}) sets config '${key}'`, id);
    } else if (!valueMatches(allowed[key] as ValueRule, value)) {
      add(
        'CONFIG_VALUE_NOT_ALLOWED',
        `node '${id}' (${node.step}) sets config '${key}' to a value outside its allowed form`,
        id
      );
    }
  }
  if (node.step === 'runQualityGates' && !Object.hasOwn(node.config ?? {}, 'gates')) {
    add(
      'QUALITY_GATES_EMPTY',
      `node '${id}' (runQualityGates) names no gates, so it verifies nothing`,
      id
    );
  }
  for (const [key, binding] of Object.entries(node.inputs ?? {})) {
    const problem = inputBindingProblem(node.step, key, binding);
    if (problem) {
      add(problem.code, `node '${id}' (${node.step}) ${problem.message}`, id);
    }
  }
}

function checkDelivering(
  spec: WorkflowSpec,
  graph: Graph,
  stages: Map<DeliveringStage, string[]>,
  reachableSuccess: string[],
  add: Add
): void {
  const ids = (s: DeliveringStage): string[] => stages.get(s) as string[];
  /** The PASSED vertices of a stage: a path through one of them has passed the stage. */
  const passed = (s: DeliveringStage): Set<string> => new Set(ids(s).map(okV));
  const required: Array<[DeliveringStage, string]> = [
    ['implementation', 'an executeImplementation node'],
    ['review', 'a runReviewNetwork node'],
    ['pullRequest', 'a createOrUpdatePullRequest node'],
    ['mergeWait', `a signal node named '${MERGE_WAIT_SIGNAL}' (the human merge wait)`],
  ];
  for (const [stage, what] of required) {
    if (ids(stage).length === 0) {
      add('MISSING_MANDATORY', `the plan has no ${what} reachable from the entry (${stage})`);
    }
  }
  if (ids('qualityGates').length === 0) {
    add(
      'QUALITY_GATE_ABSENT',
      'the plan has no quality-gate step before the pull request; the implementer and CI are the only checks',
      undefined,
      'warning'
    );
  }

  // Ordering: each present stage must be cut by the nearest earlier present stage.
  const present = DELIVERING_STAGES.filter((s) => ids(s).length > 0);
  for (let i = 1; i < present.length; i++) {
    const earlier = present[i - 1] as DeliveringStage;
    const later = present[i] as DeliveringStage;
    const blocked = passed(earlier);
    for (const node of ids(later)) {
      const path = pathAvoiding(graph, blocked, inV(node));
      if (path) {
        add(
          bypassCode(path, graph, blocked, spec, 'ORDER_VIOLATION'),
          `node '${node}' (${later}) can run without passing ${earlier}: ${describePath(path, nodeOfVertex(graph.entry) as string)}`,
          node
        );
      }
    }
  }

  // The last mandatory stage present must lie on every path to SUCCESS.
  const last = present.at(-1);
  if (last !== undefined) {
    const blocked = passed(last);
    for (const terminal of reachableSuccess) {
      const path = pathAvoiding(graph, blocked, terminal);
      if (path) {
        add(
          bypassCode(path, graph, blocked, spec, 'SUCCESS_BYPASS'),
          `the run can end SUCCESS without passing ${last}: ${describePath(path, nodeOfVertex(graph.entry) as string)}`,
          endingNode(terminal)
        );
      }
    }
  }

  // Code that changes after a check has not been checked. From every node that changes code, the
  // pull request, the merge wait and SUCCESS lie behind a re-review (and a re-gate when there are
  // gates). A gate fix is the exception that proves the rule: it is re-gated, not re-reviewed.
  const hasGates = ids('qualityGates').length > 0;
  const downstream = [
    ...ids('pullRequest').map(inV),
    ...ids('mergeWait').map(inV),
    ...reachableSuccess,
  ];
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (!changesCode(node) || !graph.reachable.has(inV(id))) {
      continue;
    }
    const gateFix = stepName(node) === GATE_FIX_STEP && hasGates;
    const needs: Array<[Set<string>, string, string]> = [];
    if (!gateFix) {
      needs.push([passed('review'), 'review', 'CODE_CHANGED_AFTER_REVIEW']);
    }
    if (hasGates) {
      needs.push([passed('qualityGates'), 'quality gates', 'CODE_CHANGED_AFTER_GATES']);
    }
    for (const [blocked, label, code] of needs) {
      if (blocked.size === 0) {
        continue;
      }
      for (const target of downstream) {
        const path = pathAvoiding(graph, blocked, target, inV(id));
        if (path) {
          add(
            code,
            `'${id}' (${stepName(node)}) changes code, and ${target.startsWith('success@') ? 'the run can end SUCCESS' : `'${nodeOfVertex(target)}' can run`} without passing ${label} again: ${describePath(path, id)}`,
            id
          );
          break;
        }
      }
    }
  }

  // A review's rejection must not reach the pull request.
  const reviewDownstream = new Set([...ids('pullRequest'), ...ids('mergeWait')]);
  for (const reviewId of ids('review')) {
    if (reviewDownstream.size === 0) {
      break;
    }
    const verdict = new RegExp(
      `^\\s*nodes\\.${escapeRegExp(reviewId)}\\.output\\.approved\\s*==\\s*true\\s*$`
    );
    const approvedEdges = new Set<string>();
    for (const [condId, cond] of Object.entries(spec.nodes)) {
      if (cond.type !== 'cond') {
        continue;
      }
      if (verdict.test(cond.expr)) {
        approvedEdges.add(`${okV(condId)}|onTrue`);
      }
    }
    const isApprovedEdge = (e: Edge): boolean => approvedEdges.has(`${e.from}|${e.field}`);
    // Search from the review's own successors, never re-entering it, never crossing an approval.
    const blocked = new Set([inV(reviewId)]);
    const viaSuccessor = (graph.adj.get(okV(reviewId)) ?? [])
      .filter((e) => e.field !== 'ok' && !isApprovedEdge(e))
      .map((e) => e.to);
    outer: for (const target of reviewDownstream) {
      for (const start of viaSuccessor) {
        if (pathAvoiding(graph, blocked, inV(target), start, isApprovedEdge)) {
          add(
            'REVIEW_VERDICT_IGNORED',
            `a rejection from review '${reviewId}' can reach '${target}'; route on a cond \`nodes.${reviewId}.output.approved == true\` and send the rejection back for a fix or to a failing end`,
            reviewId
          );
          break outer;
        }
      }
    }
  }

  // A merge wait that times out, or runs out of visits, has not merged. Searched from the wait's
  // own entry, over everything but its received signal.
  const waits = passed('mergeWait');
  for (const waitId of ids('mergeWait')) {
    for (const terminal of reachableSuccess) {
      const path = pathAvoiding(graph, waits, terminal, inV(waitId));
      if (path) {
        add(
          'MERGE_TIMEOUT_SUCCEEDS',
          `merge wait '${waitId}' can end the run SUCCESS without receiving its signal (timeout, exhaustion or failure route): ${describePath(path, waitId)}`,
          waitId
        );
        break;
      }
    }
  }
}

function checkOutputOnly(
  spec: WorkflowSpec,
  graph: Graph,
  agentNodes: Array<[string, Node]>,
  humanReviewNodes: Array<[string, Node]>,
  reachableSuccess: string[],
  add: Add
): void {
  if (agentNodes.length === 0) {
    add('MISSING_MANDATORY', 'the plan has no agent node reachable from the entry (agent)');
  }
  if (humanReviewNodes.length === 0) {
    add(
      'MISSING_MANDATORY',
      'the plan has no humanReview, humanApproval or humanDecision node reachable from the entry (humanReview)'
    );
  }
  if (agentNodes.length === 0 || humanReviewNodes.length === 0) {
    return;
  }

  // Only a review that shows an agent's output and sits after that agent reviews anything. A
  // `humanDecision` cannot say approve or reject (every option is a continuation), so it never
  // counts as the review. What a review shows is named exactly (`nodes.<agent>.output`): a
  // subpath or another path shows the reviewer nothing the agent produced. `reviewed` maps each
  // effective review to the agent whose output it shows.
  const effective: string[] = [];
  const reviewed = new Map<string, string>();
  const named = (id: string, label: string, path: string | undefined): string | undefined => {
    const source = path === undefined ? undefined : wholeOutputId(path);
    const sourceNode = source === undefined ? undefined : spec.nodes[source];
    if (source === undefined || sourceNode?.type !== 'agent') {
      add(
        'HUMAN_REVIEW_CONTENT_UNBOUND',
        `${label} '${id}' shows ${path === undefined ? 'nothing' : `'${path}'`}, which is not exactly an agent node's output (nodes.<agent>.output); the reviewer would see nothing the agent produced`,
        id
      );
      return undefined;
    }
    return source;
  };
  for (const [id, node] of humanReviewNodes) {
    if (node.type !== 'humanReview' && node.type !== 'humanApproval') {
      continue;
    }
    const source =
      node.type === 'humanReview'
        ? named(id, 'humanReview', node.contentFrom)
        : named(id, 'humanApproval', node.contextFrom);
    if (
      source !== undefined &&
      pathAvoiding(graph, new Set([okV(source)]), inV(id)) === undefined
    ) {
      effective.push(id);
      reviewed.set(id, source);
    }
  }
  if (effective.length === 0) {
    const onlyDecisions = humanReviewNodes.every(([, n]) => n.type === 'humanDecision');
    add(
      onlyDecisions ? 'HUMAN_DECISION_NOT_REVIEW' : 'HUMAN_REVIEW_BEFORE_AGENT',
      onlyDecisions
        ? 'a humanDecision treats every option as a continuation and cannot approve or reject; use a humanApproval or a humanReview of the agent output'
        : 'no human review node follows an agent node on every path and shows its output; the reviewer would see nothing the agent produced'
    );
    return;
  }
  const blocked = new Set(effective.map(okV));

  // Nothing an agent writes after the last human review may reach SUCCESS unreviewed: an agent
  // reachable once a review has passed, from which SUCCESS is reachable without passing another.
  const afterReview = new Set<string>();
  const queue = [...blocked];
  while (queue.length > 0) {
    for (const e of graph.adj.get(queue.pop() as string) ?? []) {
      if (!afterReview.has(e.to)) {
        afterReview.add(e.to);
        queue.push(e.to);
      }
    }
  }
  for (const [agentId] of agentNodes) {
    if (!afterReview.has(inV(agentId))) {
      continue;
    }
    const lateSuccess = reachableSuccess.find(
      (terminal) => pathAvoiding(graph, blocked, terminal, inV(agentId)) !== undefined
    );
    if (lateSuccess !== undefined) {
      add(
        'AGENT_AFTER_REVIEW',
        `agent '${agentId}' runs after a human review and the run can end SUCCESS without another review of its output`,
        agentId
      );
    }
  }
  for (const terminal of reachableSuccess) {
    const path = pathAvoiding(graph, blocked, terminal);
    if (path) {
      add(
        bypassCode(path, graph, blocked, spec, 'SUCCESS_BYPASS'),
        `the run can end SUCCESS without a human review of the agent output: ${describePath(path, nodeOfVertex(graph.entry) as string)}`,
        endingNode(terminal)
      );
    }
  }
  // What the run returns is what a human reviewed. A SUCCESS ending's result may carry literals
  // and the request, and the output of an agent that a review dominating that ending showed:
  // never a hidden agent's output, a scratch path an agent filled, or an expression.
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.type !== 'terminate' || node.status !== 'SUCCESS' || !graph.reachable.has(inV(id))) {
      continue;
    }
    const shown = new Set<string>();
    for (const [reviewId, agentId] of reviewed) {
      if (pathAvoiding(graph, new Set([okV(reviewId)]), inV(id)) === undefined) {
        shown.add(agentId);
      }
    }
    for (const [key, binding] of Object.entries(node.result ?? {})) {
      const kind = bindingKind(binding);
      const from = kind === 'from' ? (binding as { from: string }).from : undefined;
      const source = from === undefined ? undefined : nodeOutputId(from);
      const ok =
        kind === 'literal' ||
        (from !== undefined &&
          isSafePath(from) &&
          (from.startsWith('request.') || (source !== undefined && shown.has(source))));
      if (!ok) {
        add(
          'RESULT_UNREVIEWED',
          `terminate '${id}' returns '${key}'${from !== undefined ? ` from '${from}'` : ` as ${kind === 'expr' ? 'an expression' : 'a binding'}`}, which no human review before it showed; a SUCCESS result may carry only literals, the request, or the output of an agent a human reviewed`,
          id
        );
      }
    }
  }
  // A reviewer's rejection or a timeout is not an approval: from the review's own entry, over
  // everything but its approving answer, no SUCCESS ending may be reached.
  for (const id of effective) {
    for (const terminal of reachableSuccess) {
      const path = pathAvoiding(graph, blocked, terminal, inV(id));
      if (path) {
        add(
          'HUMAN_REJECTION_SUCCEEDS',
          `a rejection or timeout at '${id}' can end the run SUCCESS: ${describePath(path, id)}`,
          id
        );
        return;
      }
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `config` keys that override a node's behaviour: reported by name, not as merely unlisted. */
const FORBIDDEN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'agentRef',
  'allowedPaths',
  'command',
  'image',
  'skills',
  'systemPrompt',
  'testIntegrity',
  'tools',
]);

// ── Injection ──

function freshId(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) {
    return base;
  }
  let n = 2;
  while (taken.has(`${base}${n}`)) {
    n++;
  }
  return `${base}${n}`;
}

export interface SkeletonApplyResult {
  /** The spec with the canonical core attached when there was none. The input is not modified. */
  spec: WorkflowSpec;
  /** Ids of the nodes this call added. Empty when the spec already had a core. */
  injected: string[];
  /** Ids of the nodes this call removed: the author's own SUCCESS ending, replaced by the core's. */
  removed: string[];
  /** The check, run on the resulting spec, plus any `AMBIGUOUS_ANCHOR` the insertion declined. */
  report: SkeletonReport;
}

/**
 * Generation-time half of the policy: attach the canonical core when the spec has none, then run
 * {@link checkSkeletonPolicy}. NEVER call it at approval or before pinning: an approved plan is
 * checked, not rewritten.
 *
 * A `delivering` spec the generator wrote is a pre-region. If it has no node with a core id, the
 * core is attached after the pre-region's sole leaf: the one `SUCCESS` terminate (every ordinary
 * edge into it is pointed at the core entry and the terminate is dropped, because the core ends
 * the run itself), or the one dispatch or `set` node with no `next` (which gets `next` = the core
 * entry). More than one leaf, or none, adds nothing and reports `AMBIGUOUS_ANCHOR`: choosing for
 * the author would rewrite their graph. The implementation's guidance slot is bound to
 * `context.planNotes` when the pre-region writes it.
 *
 * A spec with any core id is never repaired: a partial or edited core is reported as
 * `CORE_MISMATCH` by the check. For an `output-only` plan it adds one human review before the
 * `SUCCESS` ending when the plan has an agent and a single such ending.
 */
export function applySkeletonPolicy(spec: WorkflowSpec, mode: SkeletonMode): SkeletonApplyResult {
  const next: WorkflowSpec = structuredClone(spec);
  const injected: string[] = [];
  const removed: string[] = [];
  const ambiguous: string[] = [];
  const taken = () => new Set(Object.keys(next.nodes));

  /** Point every edge in `fields`' complement into `anchors` at `head`; failure routes stay put. */
  const retarget = (
    anchors: ReadonlySet<string>,
    head: string,
    opts: { passedOnly?: boolean } = {}
  ) => {
    for (const [id, node] of Object.entries(next.nodes)) {
      let updated: Node = node;
      for (const [field, target] of nodeEdges(node)) {
        if (anchors.has(target) && !(opts.passedOnly && NOT_PASSED_FIELDS.has(field))) {
          updated = setNodeEdge(updated, field, head);
        }
      }
      next.nodes[id] = updated;
    }
    if (anchors.has(next.entry)) {
      next.entry = head;
    }
  };

  const successAnchors = (): string[] =>
    Object.entries(next.nodes)
      .filter(([, n]) => n.type === 'terminate' && n.status === 'SUCCESS')
      .map(([id]) => id);

  const add = (id: string, node: Node): void => {
    next.nodes[id] = node;
    injected.push(id);
  };

  if (mode === 'delivering') {
    const canonical = buildCanonicalCore();
    const open = Object.entries(next.nodes)
      .filter(([, n]) => endsWithoutNext(n))
      .map(([id]) => id);
    const leaves = [...successAnchors(), ...open];
    // The author's own SUCCESS ending is often called `done`, which is a core id; it is the node the
    // core replaces, so it does not count as a core node being present.
    const soleLeaf = leaves.length === 1 ? (leaves[0] as string) : undefined;
    const anyCore = Object.keys(canonical.nodes).some(
      (id) =>
        Object.hasOwn(next.nodes, id) && !(id === soleLeaf && next.nodes[id]?.type === 'terminate')
    );
    if (!anyCore) {
      if (leaves.length !== 1) {
        ambiguous.push(
          leaves.length === 0
            ? 'the pre-region has no ending to continue from (a SUCCESS terminate, or a step with no next); core not attached'
            : `the pre-region has more than one ending (${leaves.join(', ')}); core not attached`
        );
      } else if (
        !Object.values(next.nodes).some((n) => n.type === 'step' && n.step === 'validateContext') &&
        Object.keys(buildValidatePhase()).some((id) => Object.hasOwn(next.nodes, id))
      ) {
        ambiguous.push(
          'the validate phase cannot be attached: the plan already uses one of its node ids (gatherTicket, setTicket, validate, checkActionable, terminateNotActionable, setSuccessCriteria); core not attached'
        );
      } else {
        const leaf = leaves[0] as string;
        // A delivering plan validates: attach the shipped validate phase ahead of the core unless
        // the author already runs a validateContext step (then the check judges where it sits).
        const validate = Object.values(next.nodes).some(
          (n) => n.type === 'step' && n.step === 'validateContext'
        )
          ? {}
          : buildValidatePhase();
        const handover = Object.keys(validate).length > 0 ? VALIDATE_ENTRY : CORE_ENTRY;
        if (next.nodes[leaf]?.type === 'terminate') {
          retarget(new Set([leaf]), handover, { passedOnly: true });
          const stillUsed = Object.values(next.nodes).some((n) =>
            nodeEdges(n).some(([, to]) => to === leaf)
          );
          if (!stillUsed) {
            delete next.nodes[leaf];
            removed.push(leaf);
          }
        } else {
          next.nodes[leaf] = setNodeEdge(next.nodes[leaf] as Node, 'next', handover);
        }
        for (const [id, node] of Object.entries(validate)) {
          add(id, node);
        }
        for (const [id, node] of Object.entries(canonical.nodes)) {
          if (id === CORE_ENTRY && writesPlanNotes(next)) {
            const inputs = (node as { inputs?: Record<string, unknown> }).inputs ?? {};
            add(id, {
              ...node,
              inputs: { ...inputs, [CORE_GUIDANCE_SLOT.key]: { ...CORE_GUIDANCE_SLOT.binding } },
            } as Node);
          } else {
            add(id, node);
          }
        }
      }
    }
  } else {
    const agents = Object.entries(next.nodes).filter(([, n]) => n.type === 'agent');
    const hasHuman = Object.values(next.nodes).some(isHumanReviewType);
    // A plan whose steps simply stop gets an explicit SUCCESS ending, so there is a place to insert.
    if (successAnchors().length === 0) {
      const open = Object.entries(next.nodes).filter(([, n]) => endsWithoutNext(n));
      if (open.length > 0) {
        const done = freshId(taken(), 'done');
        add(done, { status: 'SUCCESS', title: 'Done', type: 'terminate' });
        for (const [id, node] of open) {
          next.nodes[id] = setNodeEdge(node, 'next', done);
        }
      }
    }
    const endings = new Set(successAnchors());
    if (agents.length > 0 && !hasHuman && endings.size > 1) {
      ambiguous.push(
        `humanReview: more than one SUCCESS ending (${[...endings].join(', ')}); not inserted`
      );
    }
    if (agents.length > 0 && !hasHuman && endings.size === 1) {
      const names = taken();
      const review = freshId(names, 'humanReviewOutput');
      names.add(review);
      const timedOut = freshId(names, 'terminateReviewTimedOut');
      const target = [...endings][0] as string;
      const lastAgent = agents.at(-1) as [string, Node];
      retarget(endings, review);
      add(review, {
        contentFrom: `nodes.${lastAgent[0]}.output`,
        onSubmit: target,
        onTimeout: timedOut,
        timeout: '7d',
        title: 'Review the result',
        type: 'humanReview',
      });
      add(timedOut, { result: {}, status: 'TIMED_OUT', type: 'terminate' });
    }
  }

  const checked = checkSkeletonPolicy(next, mode);
  if (ambiguous.length === 0) {
    return { injected, removed, report: checked, spec: next };
  }
  const extra: SkeletonIssue[] = ambiguous.map((message) => ({
    code: 'AMBIGUOUS_ANCHOR',
    message: `the mandatory stage cannot be placed without rewriting the plan's endings: ${message}`,
    severity: 'error',
  }));
  return {
    injected,
    removed,
    report: {
      ...buildReport(mode, [...checked.issues, ...extra], checked.mandatory),
      ...(checked.regions !== undefined ? { regions: checked.regions } : {}),
    },
    spec: next,
  };
}
