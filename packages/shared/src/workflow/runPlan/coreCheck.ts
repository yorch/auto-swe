/**
 * The canonical-core half of the skeleton policy for a delivering plan.
 *
 * The graph checks in `skeletonPolicy.ts` reason about an arbitrary graph, and every reasoning
 * about an arbitrary graph is a moving target. This half does not: the core is compared with a
 * fresh construction of the shipped core ({@link buildCanonicalCore}) node for node, and everything
 * that is not core is held to a small set of rules about where it may sit and what it may touch.
 *
 * Regions:
 *
 * - **core**: the nodes whose ids are the canonical core's. Each must deep-equal its canonical
 *   node, save the two mutable points ({@link CORE_HOOK}, {@link CORE_GUIDANCE_SLOT}). Core ids
 *   are reserved: a node with one of them IS a core node.
 * - **pre**: free nodes reachable from the entry without passing a core node.
 * - **post**: every other free node. In practice those reached through the hook.
 *
 * Codes: `CORE_MISMATCH` (a core node missing or not equal), `CORE_ENTERED_MIDWAY` (a free node
 * points at a core node other than the entry, or a post node at anything but the hook's return),
 * `FREE_NODE_IN_CORE` (a core node points at a free node other than through the hook),
 * `POST_HOOK_INVALID`, `POST_REGION_ESCAPE`, `FREE_NODE_TYPE_DENIED`, `FREE_STEP_DENIED`,
 * `FREE_WRITE_DENIED`, `FREE_STATUS_DENIED`, `POST_ENDS_SUCCESS` (a post-merge path that ends the
 * run SUCCESS without the merge lesson), `VALIDATE_PHASE_MISMATCH` (the validate phase is not
 * exactly the shipped one: a lone
 * `validateContext`, an edited node or a second validator), `VALIDATE_ENTRY_BYPASSED` (a path reaches a later
 * phase node or the core without passing the phase's entry node), `VALIDATE_MISSING` (a path to the core that skips
 * `validateContext`, so the review has no criteria the platform extracted) and
 * `TRANSITION_BUDGET_EXCEEDED` (pre-region, core and post-region together may exceed the
 * interpreter's transition cap, which would kill the run after the pull request is open).
 *
 * Pure and I/O-free.
 */

import { type Node, nodeEdges, type WorkflowSpec } from '../spec.js';
import {
  parsedNode as asParsedNode,
  buildCanonicalCore,
  buildValidatePhase,
  CORE_ENTRY,
  CORE_HOOK,
  normalizeCoreNode,
  sameJson,
  VALIDATE_ENTRY,
} from './canonicalCore.js';
import { freeStatusRefusal, PLAN_NOTES, under } from './skeletonBindings.js';
import { classifyRunPlanStep } from './stepAllowlist.js';
import { TRANSITION_BUDGET, worstCaseTransitions } from './transitionBudget.js';

export interface CoreIssue {
  code: string;
  message: string;
  nodeId?: string;
}

export interface CoreRegions {
  /** Core nodes present in the spec. */
  core: string[];
  /** Free nodes that run before the core. */
  pre: string[];
  /** Free nodes that run after the merge wait (or are reachable from nowhere). */
  post: string[];
}

export interface CoreCheck {
  issues: CoreIssue[];
  regions: CoreRegions;
}

/** Node types a pre-region node may have. */
const PRE_NODE_TYPES: ReadonlySet<string> = new Set([
  'agent',
  'cond',
  'humanApproval',
  'humanDecision',
  'humanInput',
  'humanReview',
  'set',
  'step',
  'terminate',
]);
/** Node types a post-region node may have: read, ask an agent, route, end. */
const POST_NODE_TYPES: ReadonlySet<string> = new Set(['agent', 'cond', 'set', 'step', 'terminate']);
/** Steps a post-region node may run: bounded reads and parsing, nothing that touches the change. */
const POST_STEPS: ReadonlySet<string> = new Set(['parseAgentOutput', 'retrieveKnowledge']);

const SCRATCH = 'context.scratch';
const TICKET = 'context.ticket';
const SUCCESS_CRITERIA = 'context.successCriteria';

/** Whether a free node of this region may write `path` at all (the source rules come after). */
function freeWriteAllowed(path: string, region: 'pre' | 'post'): boolean {
  if (under(path, SCRATCH)) {
    return true;
  }
  if (region === 'post') {
    return false;
  }
  return under(path, PLAN_NOTES) || path === TICKET || path === SUCCESS_CRITERIA;
}

/** Every context path a node writes: a `set`'s keys, and any `storeAs`. */
function writtenPaths(node: Node): string[] {
  const paths: string[] = [];
  if (node.type === 'set') {
    paths.push(...Object.keys(node.values));
  }
  const storeAs = 'storeAs' in node ? node.storeAs : undefined;
  if (typeof storeAs === 'string') {
    paths.push(storeAs);
  }
  return paths;
}

/** Whether a node with no `next` ends the run, which the interpreter reads as `SUCCESS`. */
function endsWithoutNext(node: Node): boolean {
  switch (node.type) {
    case 'step':
    case 'agent':
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

/** Whether `target` is reachable from the plan's entry along a path that enters no `blocked` node. */
function reachableAvoiding(
  spec: WorkflowSpec,
  blocked: ReadonlySet<string>,
  target: string
): boolean {
  if (blocked.has(spec.entry) || !Object.hasOwn(spec.nodes, spec.entry)) {
    return false;
  }
  const seen = new Set<string>([spec.entry]);
  const stack = [spec.entry];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === target) {
      return true;
    }
    for (const [, to] of nodeEdges(spec.nodes[cur] as Node)) {
      if (!seen.has(to) && !blocked.has(to) && Object.hasOwn(spec.nodes, to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return false;
}

export function checkCanonicalCore(spec: WorkflowSpec): CoreCheck {
  const issues: CoreIssue[] = [];
  const add = (code: string, message: string, nodeId?: string): void => {
    issues.push({ code, message, ...(nodeId !== undefined ? { nodeId } : {}) });
  };
  const canonical = buildCanonicalCore();
  const coreIds = new Set(Object.keys(canonical.nodes));
  const has = (id: string): boolean => Object.hasOwn(spec.nodes, id);
  const isCore = (id: string): boolean => coreIds.has(id);

  // ── The core nodes equal the canonical ones ──
  const missing = [...coreIds].filter((id) => !has(id));
  if (missing.length > 0) {
    add(
      'CORE_MISMATCH',
      `the canonical core is incomplete: missing ${missing.map((m) => `'${m}'`).join(', ')}`
    );
  }
  for (const id of coreIds) {
    if (!has(id)) {
      continue;
    }
    const actual = normalizeCoreNode(id, spec.nodes[id] as Node, canonical, coreIds, has);
    if (!sameJson(actual, canonical.nodes[id])) {
      const a = actual as unknown as Record<string, unknown>;
      const c = canonical.nodes[id] as unknown as Record<string, unknown>;
      const differing = [...new Set([...Object.keys(a), ...Object.keys(c)])]
        .filter((k) => !sameJson(a[k], c[k]))
        .sort();
      add(
        'CORE_MISMATCH',
        `core node '${id}' differs from the canonical core (${differing.join(', ')}); a core node is not editable`,
        id
      );
    }
  }

  // ── Regions: pre is what the entry reaches without crossing the core ──
  const pre = new Set<string>();
  if (has(spec.entry) && !isCore(spec.entry)) {
    const stack = [spec.entry];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (pre.has(cur) || isCore(cur) || !has(cur)) {
        continue;
      }
      pre.add(cur);
      for (const [, to] of nodeEdges(spec.nodes[cur] as Node)) {
        stack.push(to);
      }
    }
  }
  const free = Object.keys(spec.nodes).filter((id) => !isCore(id));
  const regionOf = (id: string): 'pre' | 'post' => (pre.has(id) ? 'pre' : 'post');
  const regions: CoreRegions = {
    core: [...coreIds].filter(has),
    post: free.filter((id) => !pre.has(id)),
    pre: free.filter((id) => pre.has(id)),
  };

  // ── The entry ──
  if (isCore(spec.entry) && spec.entry !== CORE_ENTRY) {
    add(
      'CORE_ENTERED_MIDWAY',
      `the plan starts at core node '${spec.entry}'; the core is entered at '${CORE_ENTRY}'`,
      spec.entry
    );
  }

  // ── Edges between the regions ──
  for (const id of free) {
    const region = regionOf(id);
    for (const [field, to] of nodeEdges(spec.nodes[id] as Node)) {
      if (!isCore(to)) {
        if (region === 'post' && pre.has(to)) {
          add(
            'POST_REGION_ESCAPE',
            `post-merge node '${id}'.${field} leads back to '${to}', a node that runs before the core`,
            id
          );
        }
        continue;
      }
      const entersEntry = region === 'pre' && to === CORE_ENTRY;
      const returns = region === 'post' && to === canonical.hookTarget;
      if (!entersEntry && !returns) {
        add(
          'CORE_ENTERED_MIDWAY',
          `free node '${id}'.${field} leads into core node '${to}'; a pre-region node may enter only '${CORE_ENTRY}' and a post-merge node only '${canonical.hookTarget}'`,
          id
        );
      }
    }
  }
  for (const id of coreIds) {
    if (!has(id)) {
      continue;
    }
    for (const [field, to] of nodeEdges(spec.nodes[id] as Node)) {
      if (isCore(to) || !has(to)) {
        continue;
      }
      if (id === CORE_HOOK.node && field === CORE_HOOK.field) {
        if (pre.has(to)) {
          add(
            'POST_HOOK_INVALID',
            `the merge wait's ${field} leads to '${to}', which also runs before the core`,
            id
          );
        }
        continue;
      }
      add(
        'FREE_NODE_IN_CORE',
        `core node '${id}'.${field} leads to free node '${to}'; nothing may sit between core nodes`,
        id
      );
    }
  }

  // ── What a free node may be, run and write ──
  for (const id of free) {
    const node = spec.nodes[id] as Node;
    const region = regionOf(id);
    const types = region === 'pre' ? PRE_NODE_TYPES : POST_NODE_TYPES;
    if (!types.has(node.type)) {
      add(
        'FREE_NODE_TYPE_DENIED',
        `${region === 'pre' ? 'pre-region' : 'post-merge'} node '${id}' is a '${node.type}' node, which is not allowed outside the core`,
        id
      );
    }
    if (node.type === 'step') {
      const cls = classifyRunPlanStep(node.step);
      if (cls === 'skeleton') {
        add(
          'FREE_STEP_DENIED',
          `free node '${id}' runs '${node.step}', which acts on the repository and belongs to the core only`,
          id
        );
      } else if (cls === 'free' && region === 'post' && !POST_STEPS.has(node.step)) {
        add(
          'FREE_STEP_DENIED',
          `post-merge node '${id}' runs '${node.step}'; after the merge only ${[...POST_STEPS].join(' and ')} are allowed`,
          id
        );
      }
    }
    if (node.type !== 'terminate' && node.status !== undefined) {
      const refusal = freeStatusRefusal(node.status);
      if (refusal !== undefined) {
        add('FREE_STATUS_DENIED', `free node '${id}' ${refusal}`, id);
      }
    }
    if (region === 'post') {
      // The merge lesson (`commitLesson`) is the core's, and the only road to its `done`. A
      // post-merge path that ends SUCCESS by itself skips it.
      if (
        (node.type === 'terminate' && node.status === 'SUCCESS') ||
        endsWithoutNext(node) ||
        ('onFailure' in node && routesToSuccess(node.onFailure)) ||
        (node.maxVisits !== undefined && routesToSuccess(node.onExhausted))
      ) {
        add(
          'POST_ENDS_SUCCESS',
          `post-merge node '${id}' can end the run SUCCESS; every post-merge path must return to '${canonical.hookTarget}', which stores the merge lesson, before the run ends`,
          id
        );
      }
    }
    for (const path of writtenPaths(node)) {
      if (!freeWriteAllowed(path, region)) {
        add(
          'FREE_WRITE_DENIED',
          `free node '${id}' writes '${path}'; outside the core a node may write only ${
            region === 'pre'
              ? `'${SCRATCH}.*', '${PLAN_NOTES}', '${TICKET}' and '${SUCCESS_CRITERIA}'`
              : `'${SCRATCH}.*'`
          }`,
          id
        );
      }
    }
  }

  // ── Every road to the core runs validateContext, so the review is judged against criteria the
  // platform extracted, or against none because validation found none: never against a plan's pick ──
  if (has(CORE_ENTRY)) {
    const validators = new Set(
      Object.entries(spec.nodes)
        .filter(([, n]) => n.type === 'step' && n.step === 'validateContext')
        .map(([id]) => id)
    );
    // The whole validate phase, not a lone validateContext: without the ticket gather, the
    // actionability stop and the success-criteria write the implementer would get no criteria.
    const phase = buildValidatePhase();
    const phaseIds = new Set(Object.keys(phase));
    const wrong: string[] = [];
    for (const [pid, canonicalNode] of Object.entries(phase)) {
      const actual = has(pid) ? asParsedNode(spec.nodes[pid] as Node) : undefined;
      if (actual === undefined || !sameJson(actual, canonicalNode)) {
        wrong.push(pid);
      }
    }
    const strayValidators = [...validators].filter((id) => !phaseIds.has(id));
    if (wrong.length > 0 || strayValidators.length > 0) {
      add(
        'VALIDATE_PHASE_MISMATCH',
        `the validate phase must equal ticket-to-merge's (${[...phaseIds].join(', ')}); ${
          wrong.length > 0
            ? `missing or edited: ${wrong.map((w) => `'${w}'`).join(', ')}`
            : `another validateContext step: ${strayValidators.map((w) => `'${w}'`).join(', ')}`
        }. Leave the validate phase out and the platform adds it`
      );
    }
    // The phase's ENTRY must dominate the rest of it and the core: a free `cond` that sends one
    // branch straight to a later phase node (or to the implementation) would run the phase without
    // its first node, and the ticket and actionability stop that node provides.
    if (has(VALIDATE_ENTRY)) {
      const entryOnly = new Set([VALIDATE_ENTRY]);
      const bypassed = [...phaseIds, CORE_ENTRY].filter(
        (id) => id !== VALIDATE_ENTRY && has(id) && reachableAvoiding(spec, entryOnly, id)
      );
      if (bypassed.length > 0) {
        add(
          'VALIDATE_ENTRY_BYPASSED',
          `'${VALIDATE_ENTRY}' must run before the rest of the validate phase and the core, but ${bypassed
            .map((b) => `'${b}'`)
            .join(', ')} can be reached without it`
        );
      }
    }
    if (reachableAvoiding(spec, validators, CORE_ENTRY)) {
      add(
        'VALIDATE_MISSING',
        `the core can be entered without a validateContext step running first; every path to '${CORE_ENTRY}' must pass one, as ticket-to-merge's validate phase does`
      );
    }
  }

  // ── The walk shares one transition cap; the core's share is derived from the core itself ──
  const coreBound = worstCaseTransitions(canonical.nodes, coreIds);
  const preBound = worstCaseTransitions(spec.nodes, regions.pre);
  const postBound = worstCaseTransitions(spec.nodes, regions.post);
  const total = preBound + coreBound + postBound;
  if (!(total <= TRANSITION_BUDGET)) {
    add(
      'TRANSITION_BUDGET_EXCEEDED',
      `the plan can take ${Number.isFinite(total) ? total : 'unboundedly many'} node transitions in the worst case (pre-region ${preBound}, core ${coreBound}, post-merge ${postBound}), over the ${TRANSITION_BUDGET} the interpreter allows after a safety margin; a run that hits the cap dies wherever it stands, possibly after the pull request is open. Lower maxVisits on the free nodes`
    );
  }

  return { issues, regions };
}

/** Whether the spec writes `context.planNotes` anywhere, for the injection to bind the slot. */
export function writesPlanNotes(spec: WorkflowSpec): boolean {
  return Object.values(spec.nodes).some((n) => writtenPaths(n).some((p) => under(p, PLAN_NOTES)));
}
