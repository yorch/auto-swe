/**
 * Skeleton policy for generated run plans.
 *
 * A generated plan is a mandatory skeleton plus a free middle. The policy pins the skeleton's
 * BEHAVIOUR, not its presence: a node named `runReviewNetwork` proves nothing when it carries a
 * replacement `systemPrompt`, warns instead of blocking, or can be routed around. It has two halves:
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
 * - **Configuration.** Every use of a skeleton-tier step carries only allowlisted `config` keys with
 *   allowlisted value types, no override of `systemPrompt`, `tools`, `allowedPaths`, `testIntegrity`
 *   in `config` or `inputs`, and no authored command or container code anywhere in the plan.
 * - **Failure policy.** A stage node's `onFail` is `block` or a bounded retry, never `warn`, and its
 *   `onError` is never `continue`.
 * - **Ordering by dominance.** Every path from the entry to a node of a later stage passes through a
 *   node of the earlier stage (implementation, then review, then gates, then the pull request, then
 *   the merge wait), and every path to a `SUCCESS` ending passes through the merge wait. "Passes
 *   through a node of the stage" is a cut over all of the stage's nodes, which equals dominance
 *   when the stage has one node. A path that uses an `onFailure`, `onExhausted` or `cond` edge to
 *   get around a stage is reported as such, with the path. A node that ends the run by having no
 *   `next` is a `SUCCESS` ending too, because the interpreter treats it as one.
 * - **Verdicts.** A review node's rejection cannot reach the pull request: its only way on is the
 *   approving branch of a `cond` on `nodes.<id>.output.approved`.
 * - **Loops.** Every cycle contains a node with `maxVisits` and `onExhausted`.
 *
 * For an `output-only` (library-agent) plan: at least one `agent` node, a human review node
 * (`humanReview`, `humanApproval` or `humanDecision`) after an agent node on every path to
 * `SUCCESS`, and a reachable `terminate`.
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
}

/** The signal the human merge wait listens on. */
export const MERGE_WAIT_SIGNAL = 'humanMergeSignal';

const IMPLEMENTATION_STEP = 'executeImplementation';
const REVIEW_STEP = 'runReviewNetwork';
const PULL_REQUEST_STEP = 'createOrUpdatePullRequest';
const GATE_STEPS: ReadonlySet<string> = new Set([
  'runBuild',
  'runLint',
  'runQualityGates',
  'runTests',
  'runTypecheck',
  'runVulnScan',
]);

/** Keys that override how an agent or gate behaves; never allowed in `config` or `inputs`. */
const FORBIDDEN_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  'agentRef',
  'allowedPaths',
  'command',
  'image',
  'skills',
  'systemPrompt',
  'testIntegrity',
  'tools',
]);

type ValueRule = 'boolean' | 'number' | readonly string[];

/** Allowlisted `config` keys, and the value each may take, per skeleton-tier step. */
const SKELETON_CONFIG_ALLOWLIST: Readonly<Record<string, Readonly<Record<string, ValueRule>>>> = {
  awaitQodoReview: {
    minActionLevel: ['action_required', 'remediation_recommended', 'informational'],
    waitSeconds: 'number',
  },
  commitToMemory: {},
  createOrUpdatePullRequest: { draft: 'boolean' },
  executeCIFixImplementation: { knowledgeBases: 'boolean' },
  executeGateFixImplementation: { knowledgeBases: 'boolean' },
  executeImplementation: { crossRepoContext: 'boolean', knowledgeBases: 'boolean' },
  executeReviewFixImplementation: { knowledgeBases: 'boolean' },
  fetchCILogs: {},
  resolveCiWaitConfig: {},
  runBuild: { timeoutMs: 'number' },
  runLint: { timeoutMs: 'number' },
  runQualityGates: { gates: [], isolation: ['shared', 'per-gate'], stopOnFailure: 'boolean' },
  runReviewNetwork: { crossRepoContext: 'boolean' },
  runTests: { protectTests: 'boolean', timeoutMs: 'number' },
  runTypecheck: { timeoutMs: 'number' },
  runVulnScan: { timeoutMs: 'number' },
  uiVerify: {
    failOnConsoleErrors: 'boolean',
    mode: ['smoke', 'e2e', 'both'],
    recordVideo: 'boolean',
    timeoutMs: 'number',
  },
  waitForCiByPolling: { deadlineSec: 'number', graceSec: 'number', intervalSec: 'number' },
};

// ── Graph model ──

interface Edge {
  from: string;
  to: string;
  field: string;
}

/** A node that ends the run when it has no `next`: the interpreter reads "no next" as `SUCCESS`. */
function endsWithoutNext(node: Node): boolean {
  switch (node.type) {
    case 'step':
    case 'agent':
    case 'mcp':
    case 'eval':
    case 'shell':
    case 'containerStep':
    case 'set':
      return node.next === undefined;
    default:
      return false;
  }
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
  /** Real `SUCCESS` terminate nodes plus the virtual endings below. */
  successTerminals: Set<string>;
  /** Every node reachable from the entry, virtual endings included. */
  reachable: Set<string>;
  /** Virtual endings: `success@<node>:<field>`. */
  virtual: Set<string>;
}

function successVirtualId(nodeId: string, field: string): string {
  return `success@${nodeId}:${field}`;
}

function buildGraph(spec: WorkflowSpec): Graph {
  const adj = new Map<string, Edge[]>();
  const successTerminals = new Set<string>();
  const virtual = new Set<string>();
  for (const [id, node] of Object.entries(spec.nodes)) {
    const edges: Edge[] = [];
    for (const [field, to] of nodeEdges(node)) {
      if (Object.hasOwn(spec.nodes, to)) {
        edges.push({ field, from: id, to });
      }
    }
    const addVirtual = (field: string): void => {
      const v = successVirtualId(id, field);
      virtual.add(v);
      successTerminals.add(v);
      edges.push({ field, from: id, to: v });
    };
    if (node.type === 'terminate' && node.status === 'SUCCESS') {
      successTerminals.add(id);
    }
    if ('onFailure' in node && routesToSuccess(node.onFailure)) {
      addVirtual('onFailure');
    }
    if (node.maxVisits !== undefined && routesToSuccess(node.onExhausted)) {
      addVirtual('onExhausted');
    }
    if (endsWithoutNext(node)) {
      addVirtual('next (no next: the run ends SUCCESS)');
    }
    adj.set(id, edges);
  }
  const reachable = new Set<string>();
  const stack: string[] = Object.hasOwn(spec.nodes, spec.entry) ? [spec.entry] : [];
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
  return { adj, entry: spec.entry, reachable, successTerminals, virtual };
}

/**
 * A path from the entry to `target` that avoids every node in `blocked`, or `undefined` when the
 * blocked set cuts every path. `from` starts the search somewhere other than the entry.
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

function describePath(path: Edge[], entry: string): string {
  const parts = [entry];
  for (const e of path) {
    const to = e.to.startsWith('success@') ? 'SUCCESS' : e.to;
    parts.push(`${to} (${e.field})`);
  }
  return parts.join(' -> ');
}

/**
 * Which kind of edge a bypass path leans on. The skip edge is the first edge `u -> v` on the path
 * where `u` can still reach the blocked stage and `v` no longer can: that is where the path leaves
 * the legitimate flow. A failure route or a `cond` there names the bypass; any other edge, or none
 * (the stage was never on the way), reports the fallback code.
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
  if (skip.field === 'onFailure' || skip.field === 'onExhausted') {
    return 'FAILURE_ROUTE_BYPASS';
  }
  return spec.nodes[skip.from]?.type === 'cond' ? 'COND_BYPASS' : fallback;
}

/** True when some cycle in the reachable graph contains no bounded node. */
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
    for (const e of graph.adj.get(id) ?? []) {
      if (bounded(e.to) || graph.virtual.has(e.to)) {
        continue;
      }
      if (color.get(e.to) === 1) {
        found = e.to;
        return;
      }
      if (!color.has(e.to)) {
        visit(e.to);
        if (found !== undefined) {
          return;
        }
      }
    }
    color.set(id, 2);
  };
  for (const id of graph.reachable) {
    if (!graph.virtual.has(id)) {
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

function isHumanReviewType(node: Node): boolean {
  return (
    node.type === 'humanReview' || node.type === 'humanApproval' || node.type === 'humanDecision'
  );
}

function agentKey(agentRef: string): string {
  return agentRef.split('@')[0] ?? agentRef;
}

function valueMatches(rule: ValueRule, value: unknown): boolean {
  if (rule === 'boolean') {
    return typeof value === 'boolean';
  }
  if (rule === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (rule.length === 0) {
    // `gates`: a list of gate names or `{ gate }` objects; a `command` is refused separately.
    return (
      Array.isArray(value) &&
      value.every(
        (g) =>
          typeof g === 'string' ||
          (typeof g === 'object' && g !== null && !Array.isArray(g) && !('command' in g))
      )
    );
  }
  return typeof value === 'string' && rule.includes(value);
}

// ── The check ──

export function checkSkeletonPolicy(spec: WorkflowSpec, mode: SkeletonMode): SkeletonReport {
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
  checkNodes(mode, nodes, add);

  const graph = buildGraph(spec);
  const stages = new Map<DeliveringStage, string[]>();
  for (const stage of DELIVERING_STAGES) {
    stages.set(stage, []);
  }
  for (const [id, node] of nodes) {
    const stage = stageOf(node);
    if (stage !== undefined && graph.reachable.has(id)) {
      (stages.get(stage) as string[]).push(id);
    }
  }
  const agentNodes = nodes.filter(([id, n]) => n.type === 'agent' && graph.reachable.has(id));
  const humanReviewNodes = nodes.filter(
    ([id, n]) => isHumanReviewType(n) && graph.reachable.has(id)
  );

  // Termination and loops hold for both modes.
  const reachableTerminates = nodes.filter(
    ([id, n]) => n.type === 'terminate' && graph.reachable.has(id)
  );
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

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { errors, issues, mandatory, mode, ok: errors.length === 0, warnings };
}

type Add = (code: string, message: string, nodeId?: string, severity?: SkeletonSeverity) => void;

function checkNodes(mode: SkeletonMode, nodes: Array<[string, Node]>, add: Add): void {
  for (const [id, node] of nodes) {
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
          `agent node '${id}' replaces the agent's system prompt`,
          id,
          mode === 'output-only' ? 'error' : 'warning'
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
    if (cls === 'skeleton') {
      checkSkeletonStepConfig(id, node, add);
    }
    if (stageOf(node) !== undefined) {
      if (node.onFail === 'warn') {
        add(
          'ONFAIL_WARN',
          `node '${id}' (${node.step}) continues after a failure (onFail: warn); a mandatory node must block`,
          id
        );
      }
      if (node.onError === 'continue') {
        add(
          'ONERROR_CONTINUE',
          `node '${id}' (${node.step}) swallows errors (onError: continue); a mandatory node must fail the run`,
          id
        );
      }
    }
  }
}

function checkSkeletonStepConfig(
  id: string,
  node: Extract<Node, { type: 'step' }>,
  add: Add
): void {
  const allowed = SKELETON_CONFIG_ALLOWLIST[node.step] ?? {};
  for (const [key, value] of Object.entries(node.config ?? {})) {
    if (FORBIDDEN_OVERRIDE_KEYS.has(key)) {
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
  for (const key of Object.keys(node.inputs ?? {})) {
    if (FORBIDDEN_OVERRIDE_KEYS.has(key)) {
      add(
        'OVERRIDE_FORBIDDEN',
        `node '${id}' (${node.step}) binds input '${key}', which overrides the platform's behaviour`,
        id
      );
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
    const blocked = new Set(ids(earlier));
    for (const node of ids(later)) {
      const path = pathAvoiding(graph, blocked, node);
      if (path) {
        add(
          bypassCode(path, graph, blocked, spec, 'ORDER_VIOLATION'),
          `node '${node}' (${later}) can run without passing ${earlier}: ${describePath(path, graph.entry)}`,
          node
        );
      }
    }
  }

  // The last mandatory stage present must lie on every path to SUCCESS.
  const last = present.at(-1);
  if (last !== undefined) {
    const blocked = new Set(ids(last));
    for (const terminal of reachableSuccess) {
      const path = pathAvoiding(graph, blocked, terminal);
      if (path) {
        const nodeId = terminal.startsWith('success@') ? terminal.slice(8).split(':')[0] : terminal;
        add(
          bypassCode(path, graph, blocked, spec, 'SUCCESS_BYPASS'),
          `the run can end SUCCESS without passing ${last}: ${describePath(path, graph.entry)}`,
          nodeId
        );
      }
    }
  }

  // A review's rejection must not reach the pull request.
  const downstream = new Set([...ids('pullRequest'), ...ids('mergeWait')]);
  for (const reviewId of ids('review')) {
    if (downstream.size === 0) {
      break;
    }
    const verdict = new RegExp(
      `^\\s*nodes\\.${escapeRegExp(reviewId)}\\.output\\.approved\\s*==\\s*(true|false)\\s*$`
    );
    const approvedEdges = new Set<string>();
    for (const [condId, cond] of Object.entries(spec.nodes)) {
      if (cond.type !== 'cond') {
        continue;
      }
      const m = verdict.exec(cond.expr);
      if (m) {
        approvedEdges.add(`${condId}|${m[1] === 'true' ? 'onTrue' : 'onFalse'}`);
      }
    }
    const blocked = new Set([reviewId]);
    for (const target of downstream) {
      // Search from the review's own successors, never re-entering it, never crossing an approval.
      const viaSuccessor = (graph.adj.get(reviewId) ?? [])
        .filter((e) => !approvedEdges.has(`${e.from}|${e.field}`))
        .map((e) => e.to);
      let leak: Edge[] | undefined;
      for (const start of viaSuccessor) {
        const tail = pathAvoiding(graph, blocked, target, start, (e) =>
          approvedEdges.has(`${e.from}|${e.field}`)
        );
        if (tail) {
          leak = tail;
          break;
        }
      }
      if (leak) {
        add(
          'REVIEW_VERDICT_IGNORED',
          `a rejection from review '${reviewId}' can reach '${target}'; route on a cond \`nodes.${reviewId}.output.approved == true\` and send the rejection back for a fix or to a failing end`,
          reviewId
        );
        break;
      }
    }
  }

  // A merge wait that times out has not merged.
  for (const waitId of ids('mergeWait')) {
    const wait = spec.nodes[waitId];
    if (wait?.type !== 'signal') {
      continue;
    }
    const blocked = new Set([waitId]);
    for (const terminal of reachableSuccess) {
      const path = pathAvoiding(graph, blocked, terminal, wait.onTimeout);
      if (path) {
        add(
          'MERGE_TIMEOUT_SUCCEEDS',
          `merge wait '${waitId}' times out into a SUCCESS ending: ${describePath(path, wait.onTimeout)}`,
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
  const agents = new Set(agentNodes.map(([id]) => id));
  // Only a review that sits after an agent reviews anything.
  const effective = humanReviewNodes
    .map(([id]) => id)
    .filter((id) => pathAvoiding(graph, agents, id) === undefined);
  if (effective.length === 0) {
    add(
      'HUMAN_REVIEW_BEFORE_AGENT',
      'no human review node follows an agent node on every path; the reviewer would see nothing the agent produced'
    );
    return;
  }
  const blocked = new Set(effective);
  for (const terminal of reachableSuccess) {
    const path = pathAvoiding(graph, blocked, terminal);
    if (path) {
      const nodeId = terminal.startsWith('success@') ? terminal.slice(8).split(':')[0] : terminal;
      add(
        bypassCode(path, graph, blocked, spec, 'SUCCESS_BYPASS'),
        `the run can end SUCCESS without a human review of the agent output: ${describePath(path, graph.entry)}`,
        nodeId
      );
    }
  }
  // A reviewer's rejection or a timeout is not an approval.
  for (const id of effective) {
    const node = spec.nodes[id] as Node;
    const nonApproving: string[] = [];
    if (node.type === 'humanApproval') {
      nonApproving.push(node.onReject, node.onTimeout);
      if (node.onRequestChanges) {
        nonApproving.push(node.onRequestChanges);
      }
    } else if (node.type === 'humanReview' || node.type === 'humanDecision') {
      nonApproving.push(node.onTimeout);
    }
    for (const start of nonApproving) {
      for (const terminal of reachableSuccess) {
        const path = pathAvoiding(graph, new Set([id]), terminal, start);
        if (path) {
          add(
            'HUMAN_REJECTION_SUCCEEDS',
            `a rejection or timeout at '${id}' can end the run SUCCESS: ${describePath(path, start)}`,
            id
          );
          return;
        }
      }
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Injection ──

export interface SkeletonApplyResult {
  /** The spec with any plainly missing mandatory nodes inserted. The input is not modified. */
  spec: WorkflowSpec;
  /** Ids of the nodes this call added. Empty when the spec already had every mandatory stage. */
  injected: string[];
  /** The check, run on the resulting spec. */
  report: SkeletonReport;
}

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

/**
 * Generation-time half of the policy: insert the mandatory nodes that are plainly missing, then
 * run {@link checkSkeletonPolicy}. NEVER call it at approval or before pinning: an approved plan is
 * checked, not rewritten.
 *
 * Insertion is deliberately small. It adds, for a `delivering` plan, an implementation node at the
 * entry, and a review (with its approval `cond` and a failing end), a pull request step and a merge
 * wait immediately before the node set that follows them, or before the `SUCCESS` ending when
 * nothing follows. It does not add quality gates, does not touch a node that exists, and does not
 * invent an agent or a terminate. When an insertion point is ambiguous (several nodes of the stage
 * that should follow) it adds nothing and leaves the check to report the gap. For an `output-only`
 * plan it adds one human review before the `SUCCESS` ending when the plan has an agent and a single
 * such ending. Whatever it cannot place stays missing, and the report says so.
 */
export function applySkeletonPolicy(spec: WorkflowSpec, mode: SkeletonMode): SkeletonApplyResult {
  const next: WorkflowSpec = structuredClone(spec);
  const injected: string[] = [];
  const taken = () => new Set(Object.keys(next.nodes));

  const stageIds = (stage: DeliveringStage): string[] =>
    Object.entries(next.nodes)
      .filter(([, n]) => stageOf(n) === stage)
      .map(([id]) => id);

  /** Point every edge into `anchors` at `head`. */
  const retarget = (anchors: ReadonlySet<string>, head: string, exclude: ReadonlySet<string>) => {
    for (const [id, node] of Object.entries(next.nodes)) {
      if (exclude.has(id)) {
        continue;
      }
      let updated: Node = node;
      for (const [field, target] of nodeEdges(node)) {
        if (anchors.has(target)) {
          updated = setNodeEdge(updated, field, head);
        }
      }
      next.nodes[id] = updated;
    }
    if (anchors.has(next.entry)) {
      next.entry = head;
    }
  };

  const successAnchors = (): Set<string> =>
    new Set(
      Object.entries(next.nodes)
        .filter(([, n]) => n.type === 'terminate' && n.status === 'SUCCESS')
        .map(([id]) => id)
    );

  const add = (id: string, node: Node): void => {
    next.nodes[id] = node;
    injected.push(id);
  };

  /**
   * Give a plan whose steps simply stop (no `next`, no terminate) an explicit `SUCCESS` ending, so
   * there is a place to insert before. A plan with its own ending is left alone.
   */
  const ensureSuccessEnding = (): void => {
    if (successAnchors().size > 0) {
      return;
    }
    const open = Object.entries(next.nodes).filter(([, n]) => endsWithoutNext(n));
    if (open.length === 0) {
      return;
    }
    const done = freshId(taken(), 'done');
    add(done, { status: 'SUCCESS', title: 'Done', type: 'terminate' });
    for (const [id, node] of open) {
      next.nodes[id] = setNodeEdge(node, 'next', done);
    }
  };

  if (mode === 'delivering') {
    ensureSuccessEnding();
    if (stageIds('implementation').length === 0) {
      const id = freshId(taken(), 'implement');
      add(id, {
        group: 'implement',
        next: next.entry,
        status: 'IMPLEMENTING',
        step: IMPLEMENTATION_STEP,
        storeAs: 'context.currentCodeResult',
        title: 'Implement the request',
        type: 'step',
      });
      next.entry = id;
    }

    const later: Record<'review' | 'pullRequest' | 'mergeWait', DeliveringStage[]> = {
      mergeWait: [],
      pullRequest: ['mergeWait'],
      review: ['qualityGates', 'pullRequest', 'mergeWait'],
    };
    for (const stage of ['review', 'pullRequest', 'mergeWait'] as const) {
      if (stageIds(stage).length > 0) {
        continue;
      }
      // Anchor: the nodes of the first later stage that exists, else the SUCCESS ending.
      let anchors: Set<string> | undefined;
      for (const l of later[stage]) {
        const found = stageIds(l);
        if (found.length > 0) {
          anchors = new Set(found);
          break;
        }
      }
      const useSuccess = anchors === undefined;
      const anchorSet = anchors ?? successAnchors();
      if (anchorSet.size === 0 || (!useSuccess && anchorSet.size !== 1)) {
        continue;
      }
      const target = [...anchorSet][0] as string;
      const names = taken();
      if (stage === 'review') {
        const review = freshId(names, 'review');
        names.add(review);
        const check = freshId(names, 'checkApproval');
        names.add(check);
        const failed = freshId(names, 'terminateReviewFailed');
        retarget(anchorSet, review, new Set());
        add(review, {
          group: 'review',
          inputs: { codeResult: { from: 'context.currentCodeResult' } },
          next: check,
          status: 'IN_REVIEW',
          step: REVIEW_STEP,
          title: 'Review the change',
          type: 'step',
        });
        add(check, {
          expr: `nodes.${review}.output.approved == true`,
          group: 'review',
          onFalse: failed,
          onTrue: target,
          type: 'cond',
        });
        add(failed, {
          group: 'review',
          result: { message: { literal: 'The review rejected the change.' } },
          status: 'FAILED',
          type: 'terminate',
        });
      } else if (stage === 'pullRequest') {
        const pr = freshId(names, 'openPR');
        retarget(anchorSet, pr, new Set());
        add(pr, {
          group: 'pull request',
          inputs: { codeResult: { from: 'context.currentCodeResult' } },
          next: target,
          status: 'AWAITING_CI',
          step: PULL_REQUEST_STEP,
          title: 'Open the pull request',
          type: 'step',
        });
      } else {
        const wait = freshId(names, 'waitForHumanMerge');
        names.add(wait);
        const timedOut = freshId(names, 'terminateMergeTimedOut');
        retarget(anchorSet, wait, new Set());
        add(wait, {
          group: 'human merge',
          name: MERGE_WAIT_SIGNAL,
          onReceive: target,
          onTimeout: timedOut,
          status: 'AWAITING_HUMAN_MERGE',
          timeout: '7d',
          title: 'Wait for a person to merge',
          type: 'signal',
        });
        add(timedOut, {
          group: 'human merge',
          result: {},
          status: 'TIMED_OUT',
          type: 'terminate',
        });
      }
    }
  } else {
    const agents = Object.entries(next.nodes).filter(([, n]) => n.type === 'agent');
    const hasHuman = Object.values(next.nodes).some(isHumanReviewType);
    ensureSuccessEnding();
    const endings = successAnchors();
    if (agents.length > 0 && !hasHuman && endings.size === 1) {
      const names = taken();
      const review = freshId(names, 'humanReviewOutput');
      names.add(review);
      const timedOut = freshId(names, 'terminateReviewTimedOut');
      const target = [...endings][0] as string;
      const lastAgent = agents.at(-1) as [string, Node];
      retarget(endings, review, new Set());
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

  return { injected, report: checkSkeletonPolicy(next, mode), spec: next };
}
