/**
 * What a generated plan may put in a step's `config` and `inputs`, and where it may write.
 *
 * The skeleton policy pins the behaviour of the mandatory nodes, but a node is only as pinned as the
 * values that reach it. The worker reads far more than `config`: `inputs.codeResult` replaces the
 * change a review looks at, `inputs.branch` points the gates at another branch, `inputs.command`
 * replaces a gate's command. And the run context is writable by `set` nodes and `storeAs`, so a
 * plan that cannot override a node's input directly could still forge the context path the node
 * falls back to (`context.currentCodeResult`) or the verdict a `cond` reads (`nodes.review.output`).
 *
 * So this module is an ALLOWLIST in three parts, every one fail-closed:
 *
 * 1. {@link STEP_CONFIG_ALLOWLIST}: the `config` keys and value forms each step may carry.
 * 2. {@link STEP_INPUT_ALLOWLIST}: the `inputs` keys each step may bind, and for each key the
 *    context paths it may be bound FROM. A security-relevant key takes no `literal` and no `expr`:
 *    a plan can route data the platform produced to a node, never author it.
 * 3. {@link writeRefusal}: where a `set` node or a `storeAs` may write. Never `nodes.*`, `request.*`
 *    or `workflow.*`; under `context.` only `context.scratch.*` (which no skeleton input may read
 *    from), or one of the named plumbing paths the platform's own macros use, each with the form of
 *    value it may receive.
 *
 * Pure and I/O-free.
 */

import type { Binding, Node, WorkflowSpec } from '../spec.js';

export type ValueRule = 'boolean' | 'number' | 'string' | 'timeoutMs' | 'gates' | readonly string[];

/** The quality-gate names a batch (or a config) may run. `runPerfBench` has no default command. */
export const ALLOWED_GATE_NAMES: ReadonlySet<string> = new Set([
  'runBuild',
  'runLint',
  'runTests',
  'runTypecheck',
  'runVulnScan',
]);

/** Short spellings a gate list is written with; accepted because they name the same five gates. */
const SHORT_GATE_NAMES: ReadonlySet<string> = new Set([
  'build',
  'lint',
  'test',
  'tests',
  'typecheck',
  'vuln',
  'vulnscan',
]);

/** Keys that override how an agent or gate behaves; never allowed in `config` or `inputs`. */
export const FORBIDDEN_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  'agentRef',
  'allowedPaths',
  'command',
  'image',
  'skills',
  'systemPrompt',
  'testIntegrity',
  'tools',
]);

/** The steps that change the code in the run's checkout. */
export const CODE_CHANGING_STEPS: ReadonlySet<string> = new Set([
  'executeCIFixImplementation',
  'executeGateFixImplementation',
  'executeImplementation',
  'executeReviewFixImplementation',
]);

/** Allowlisted `config` keys, and the value each may take, per step. A step not listed takes none. */
export const STEP_CONFIG_ALLOWLIST: Readonly<Record<string, Readonly<Record<string, ValueRule>>>> =
  {
    // ── free tier: these read `config.systemPrompt` and similar, so they are held to a list too ──
    analyzePrd: {},
    // ── skeleton tier ──
    awaitQodoReview: {
      minActionLevel: ['action_required', 'remediation_recommended', 'informational'],
      waitSeconds: 'number',
    },
    commitToMemory: {},
    createOrUpdatePullRequest: { draft: 'boolean' },
    decomposePrd: {},
    executeCIFixImplementation: { knowledgeBases: 'boolean' },
    executeGateFixImplementation: { knowledgeBases: 'boolean' },
    executeImplementation: { crossRepoContext: 'boolean', knowledgeBases: 'boolean' },
    executeReviewFixImplementation: { knowledgeBases: 'boolean' },
    fetchCILogs: {},
    gatherTicketContext: {},
    parseAgentOutput: {
      kind: [
        'ticketPlan',
        'incidentTriage',
        'incidentPostmortem',
        'repoOnboardingDraft',
        'docReview',
      ],
    },
    planDecomposition: { knowledgeBases: 'boolean' },
    resolveCiWaitConfig: {},
    retrieveKnowledge: { knowledgeBases: 'boolean', limit: 'number', query: 'string' },
    runBuild: { timeoutMs: 'timeoutMs' },
    runLint: { timeoutMs: 'timeoutMs' },
    runQualityGates: {
      gates: 'gates',
      isolation: ['shared', 'per-gate'],
      stopOnFailure: 'boolean',
    },
    runReviewNetwork: { crossRepoContext: 'boolean' },
    runTests: { protectTests: 'boolean', timeoutMs: 'timeoutMs' },
    runTypecheck: { timeoutMs: 'timeoutMs' },
    runVulnScan: { timeoutMs: 'timeoutMs' },
    uiVerify: {
      failOnConsoleErrors: 'boolean',
      mode: ['smoke', 'e2e', 'both'],
      recordVideo: 'boolean',
      timeoutMs: 'timeoutMs',
    },
    validateContext: {},
    waitForCiByPolling: { deadlineSec: 'number', graceSec: 'number', intervalSec: 'number' },
  };

/** The step names {@link STEP_CONFIG_ALLOWLIST} governs. */
export function hasConfigAllowlist(step: string): boolean {
  return Object.hasOwn(STEP_CONFIG_ALLOWLIST, step);
}

function isGateEntry(entry: unknown): boolean {
  if (typeof entry === 'string') {
    return ALLOWED_GATE_NAMES.has(entry) || SHORT_GATE_NAMES.has(entry.toLowerCase());
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return false;
  }
  // Only the keys a batch gate has. `command` is an authored command; any other key is unknown.
  const keys = Object.keys(entry);
  if (!keys.every((k) => k === 'name' || k === 'timeoutMs')) {
    return false;
  }
  const { name, timeoutMs } = entry as { name?: unknown; timeoutMs?: unknown };
  return (
    typeof name === 'string' &&
    ALLOWED_GATE_NAMES.has(name) &&
    (timeoutMs === undefined || isTimeoutMs(timeoutMs))
  );
}

function isTimeoutMs(value: unknown): boolean {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 3_600_000
  );
}

/** Whether `value` is of the allowed form `rule` names. */
export function valueMatches(rule: ValueRule, value: unknown): boolean {
  if (rule === 'boolean') {
    return typeof value === 'boolean';
  }
  if (rule === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (rule === 'timeoutMs') {
    return isTimeoutMs(value);
  }
  if (rule === 'string') {
    return typeof value === 'string' && value.length <= 500;
  }
  if (rule === 'gates') {
    return Array.isArray(value) && value.length > 0 && value.every(isGateEntry);
  }
  return typeof value === 'string' && rule.includes(value);
}

// ── Inputs ──

/**
 * A context path an input may be bound from. An exact path, a prefix ending `.*`, or
 * {@link NODE_OUTPUT}: any `nodes.<id>.output[.field…]`, the output of a node the plan ran.
 */
export const NODE_OUTPUT = '#nodeOutput';

export interface InputRule {
  /** Paths the key may be bound from with a `from` binding. */
  from: readonly string[];
  /** Whether a `literal` binding is accepted, and which. Absent: no literal. */
  literal?: (value: unknown) => boolean;
  /** The `default` values a `from` binding may carry. Absent or empty: no default. */
  defaults?: readonly unknown[];
}

/** The notes the pre-region leaves for the implementer: the one pre-region-to-core channel. */
export const PLAN_NOTES = 'context.planNotes';

const CODE_RESULT_PATH = 'context.currentCodeResult';
const codeResultInput: InputRule = { from: [CODE_RESULT_PATH] };
const branchInput: InputRule = { from: [`${CODE_RESULT_PATH}.branch`] };

const identifierLiteral = (v: unknown): boolean =>
  typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);

/**
 * `inputs` keys each step may bind. A step not listed, and a key not listed under a step, takes
 * nothing. There is no `literal` and no `expr` for `codeResult`, `previousCodeResult`, `branch`,
 * `successCriteria`, `previousFingerprint` or any free-text key the platform turns into a prompt
 * (`guidance`, `ticket`, `rejectionSummary`, `failureContext`): they are routed, not authored.
 */
export const STEP_INPUT_ALLOWLIST: Readonly<Record<string, Readonly<Record<string, InputRule>>>> = {
  analyzePrd: {},
  awaitQodoReview: {
    headSha: { from: [`${CODE_RESULT_PATH}.headSha`, NODE_OUTPUT] },
    prUrl: { from: ['context.prUrl', NODE_OUTPUT] },
  },
  commitToMemory: {
    // `repoId` is deliberately absent: the lesson is written for the run's own repository.
    outcome: {
      from: [],
      literal: (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(v),
    },
  },
  createOrUpdatePullRequest: { codeResult: codeResultInput },
  decomposePrd: { analysis: { from: [NODE_OUTPUT] }, pmFeedback: { from: [NODE_OUTPUT] } },
  executeCIFixImplementation: {
    failureContext: { defaults: [''], from: ['context.lastCILogs'] },
    previousCodeResult: codeResultInput,
  },
  executeGateFixImplementation: {
    gateName: { from: [NODE_OUTPUT], literal: identifierLiteral },
    gateOutput: { from: ['context.lastGateOutput', NODE_OUTPUT] },
    previousCodeResult: codeResultInput,
  },
  executeImplementation: {
    // The one channel from the pre-region to the implementer: `context.planNotes` and nothing else.
    guidance: { from: [PLAN_NOTES] },
    successCriteria: { defaults: [[]], from: ['context.successCriteria'] },
    ticket: { defaults: [''], from: ['context.ticket'] },
  },
  executeReviewFixImplementation: {
    previousCodeResult: codeResultInput,
    rejectionSummary: { defaults: [''], from: ['context.lastRejectionSummary'] },
  },
  fetchCILogs: { logsUrl: { from: ['context.ciResultPayload.logsUrl', NODE_OUTPUT] } },
  gatherTicketContext: {},
  parseAgentOutput: { text: { from: [NODE_OUTPUT] } },
  planDecomposition: {},
  resolveCiWaitConfig: {},
  retrieveKnowledge: {
    limit: {
      from: [],
      literal: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 20,
    },
    query: {
      from: [NODE_OUTPUT, 'request.description'],
      literal: (v) => typeof v === 'string' && v.length <= 500,
    },
  },
  runBuild: { branch: branchInput },
  runLint: { branch: branchInput },
  runQualityGates: { branch: branchInput },
  runReviewNetwork: {
    codeResult: codeResultInput,
    previousFingerprint: { defaults: [''], from: ['context.lastReviewFingerprint'] },
    successCriteria: { defaults: [[]], from: ['context.successCriteria'] },
  },
  runTests: { branch: branchInput },
  runTypecheck: { branch: branchInput },
  runVulnScan: { branch: branchInput },
  uiVerify: { branch: branchInput },
  // The platform's own digest only: text an agent wrote must not become the ticket validation reads.
  validateContext: { ticket: { defaults: [''], from: ['context.ticket'] } },
  waitForCiByPolling: {
    deadlineSec: { from: [NODE_OUTPUT] },
    graceSec: { from: [NODE_OUTPUT] },
    intervalSec: { from: [NODE_OUTPUT] },
    ref: branchInput,
  },
};

/** A path made only of plain identifier segments: no brackets, quotes or empty segments. */
const SAFE_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
const NODE_OUTPUT_PATH = /^nodes\.([A-Za-z0-9_-]+)\.output(?:\.[A-Za-z0-9_-]+)*$/;
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafePath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.split('.').some((s) => RESERVED_SEGMENTS.has(s));
}

/** The node id of a `nodes.<id>.output[…]` path, or `undefined` when the path is anything else. */
export function nodeOutputId(path: string): string | undefined {
  return NODE_OUTPUT_PATH.exec(path)?.[1];
}

const AGENT_OUTPUT_PATH = /^nodes\.([A-Za-z0-9_-]+)\.output$/;

/**
 * The node id of exactly `nodes.<id>.output`: the whole answer of a node, which is what a human
 * review shows. A subpath (`nodes.draft.output.nonexistent`) is not the output and shows nothing.
 */
export function wholeOutputId(path: string): string | undefined {
  return isSafePath(path) ? AGENT_OUTPUT_PATH.exec(path)?.[1] : undefined;
}

function pathAllowed(path: string, roots: readonly string[]): boolean {
  if (!isSafePath(path)) {
    return false;
  }
  return roots.some((root) => {
    if (root === NODE_OUTPUT) {
      return nodeOutputId(path) !== undefined;
    }
    if (root.endsWith('.*')) {
      return path.startsWith(root.slice(0, -1));
    }
    return path === root;
  });
}

type BindingKind = 'from' | 'literal' | 'expr' | 'ambiguous';

/** Which way `resolveBinding` would read this binding; an object that is two things is refused. */
export function bindingKind(binding: Binding): BindingKind {
  const b = binding as Record<string, unknown>;
  const present = ['from', 'literal', 'expr'].filter((k) => k in b);
  if (present.length !== 1) {
    return 'ambiguous';
  }
  const extra = Object.keys(b).filter(
    (k) => k !== present[0] && !(present[0] === 'from' && k === 'default')
  );
  if (extra.length > 0) {
    return 'ambiguous';
  }
  return present[0] as BindingKind;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface BindingProblem {
  code: string;
  message: string;
}

/** Whether `binding` may be bound to `key` of `step`, with the reason it may not. */
export function inputBindingProblem(
  step: string,
  key: string,
  binding: Binding
): BindingProblem | undefined {
  if (FORBIDDEN_OVERRIDE_KEYS.has(key)) {
    return {
      code: 'OVERRIDE_FORBIDDEN',
      message: `binds input '${key}', which overrides the platform's behaviour`,
    };
  }
  const rules = STEP_INPUT_ALLOWLIST[step] ?? {};
  const rule = Object.hasOwn(rules, key) ? (rules[key] as InputRule) : undefined;
  if (rule === undefined) {
    return {
      code: 'INPUT_KEY_NOT_ALLOWED',
      message: `binds input '${key}', which a generated plan may not set on this step`,
    };
  }
  const kind = bindingKind(binding);
  if (kind === 'ambiguous') {
    return {
      code: 'INPUT_BINDING_AMBIGUOUS',
      message: `binds input '${key}' with an object that is more than one of from, literal and expr`,
    };
  }
  if (kind === 'expr') {
    return {
      code: 'INPUT_EXPR_FORBIDDEN',
      message: `binds input '${key}' with an expression; a plan routes this input from a context path`,
    };
  }
  if (kind === 'literal') {
    const value = (binding as { literal: unknown }).literal;
    return rule.literal?.(value) === true
      ? undefined
      : {
          code: 'INPUT_LITERAL_FORBIDDEN',
          message: `binds input '${key}' to a literal value; the plan may route it from a context path but not author it`,
        };
  }
  const { from, default: dflt } = binding as { from: string; default?: unknown };
  if (!pathAllowed(from, rule.from)) {
    return {
      code: 'INPUT_SOURCE_NOT_ALLOWED',
      message: `binds input '${key}' from '${from}', which is not a source this input may read`,
    };
  }
  if (dflt !== undefined && !(rule.defaults ?? []).some((d) => sameJson(d, dflt))) {
    return {
      code: 'INPUT_DEFAULT_NOT_ALLOWED',
      message: `binds input '${key}' with a default value, which stands in for the platform's data when the path is empty`,
    };
  }
  return undefined;
}

// ── Writes ──

const SCRATCH_PREFIX = 'context.scratch';

/** Context paths the platform's own loops write, and what each may receive. */
interface Plumbing {
  /** A literal `null` or `''` may reset it. */
  clearable: boolean;
  /** The node types whose output may be copied into it. */
  nodeTypes: ReadonlySet<string>;
  /** When `step` is a source type: the steps whose output may be copied. Absent: any step. */
  steps?: ReadonlySet<string>;
  /**
   * The one field of the source's output that fills the path: a copy must be exactly
   * `nodes.<id>.output.<field>`. Another field of the same step (`ambiguities` for the success
   * criteria) is not what the template copies, and the whole output (`storeAs`) is not either.
   */
  field?: string;
}
const stepsOnly = (...steps: string[]): Pick<Plumbing, 'nodeTypes' | 'steps'> => ({
  nodeTypes: new Set(['step']),
  steps: new Set(steps),
});
const GATE_STEP_NAMES = [
  'runBuild',
  'runLint',
  'runQualityGates',
  'runTests',
  'runTypecheck',
  'runVulnScan',
];
/**
 * Each path takes the output of the one kind of node that fills it in the shipped graph. An agent
 * is a source only for the plan notes: text an agent wrote must never become the success criteria
 * the review is judged against, the ticket, a rejection summary or CI logs the fix steps are told.
 */
const DERIVED_PATHS: Readonly<Record<string, Plumbing>> = {
  'context.ciResultPayload': {
    clearable: true,
    nodeTypes: new Set(['signal', 'step']),
    steps: new Set(['waitForCiByPolling']),
  },
  'context.lastCILogs': { clearable: true, ...stepsOnly('fetchCILogs') },
  'context.lastGateOutput': { clearable: true, ...stepsOnly(...GATE_STEP_NAMES) },
  'context.lastRejectionSummary': { clearable: true, ...stepsOnly('runReviewNetwork') },
  'context.lastReviewFingerprint': { clearable: true, ...stepsOnly('runReviewNetwork') },
  [PLAN_NOTES]: { clearable: true, nodeTypes: new Set(['agent', 'step']) },
  'context.prNumber': { clearable: false, ...stepsOnly('createOrUpdatePullRequest') },
  'context.prUrl': { clearable: false, ...stepsOnly('createOrUpdatePullRequest') },
  'context.successCriteria': {
    clearable: false,
    field: 'successCriteria',
    ...stepsOnly('validateContext'),
  },
  'context.ticket': { clearable: false, field: 'text', ...stepsOnly('gatherTicketContext') },
};

function sourceAllowed(plumbing: Plumbing, node: Node): boolean {
  if (!plumbing.nodeTypes.has(node.type)) {
    return false;
  }
  return node.type !== 'step' || plumbing.steps === undefined || plumbing.steps.has(node.step);
}
/** Loop counters: only a `cond` reads them, never a skeleton input. */
const COUNTER_PATHS: readonly string[] = ['context.ciRetries'];

export function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}.`);
}

function describeNode(node: Node): string {
  return node.type === 'step'
    ? `the output of the ${node.step} step`
    : `a ${node.type} node's answer`;
}

function describeSources(plumbing: Plumbing): string {
  const types = [...plumbing.nodeTypes];
  const steps = plumbing.steps === undefined ? '' : ` (${[...plumbing.steps].join(', ')})`;
  return types.length === 1 && types[0] === 'step'
    ? `a ${[...(plumbing.steps ?? [])].join(' or ') || 'step'} step`
    : `a ${types.join(' or ')} node${steps}`;
}

export type WriteSource = { kind: 'set'; binding: Binding } | { kind: 'storeAs'; node: Node };

/**
 * Why a write to `path` is refused, or `undefined` when it is allowed.
 *
 * `nodes.*` is never writable: a plan that could write `nodes.review.output.approved` would answer
 * its own cond. `request.*` and `workflow.*` are the run's identity. Under `context.`, the only
 * free namespace is `context.scratch`; the other paths are named, and a skeleton input may be
 * bound from them only because a write to them is held to the forms below, so a value there came
 * from a node the plan ran.
 */
export function writeRefusal(
  path: string,
  source: WriteSource,
  spec: WorkflowSpec
): BindingProblem | undefined {
  if (!isSafePath(path)) {
    return {
      code: 'WRITE_PATH_INVALID',
      message: `writes '${path}', which is not a plain dotted path`,
    };
  }
  const segments = path.split('.');
  if (segments[0] !== 'context' || segments.length < 2) {
    return {
      code: 'RESERVED_PATH_WRITE',
      message: `writes '${path}'; a generated plan may write only under 'context.' (use '${SCRATCH_PREFIX}.*' for working values)`,
    };
  }
  if (under(path, SCRATCH_PREFIX)) {
    return undefined;
  }
  if (COUNTER_PATHS.some((p) => under(path, p))) {
    return undefined;
  }

  if (path === CODE_RESULT_PATH || under(path, CODE_RESULT_PATH)) {
    const exact = path === CODE_RESULT_PATH;
    if (source.kind === 'storeAs') {
      const n = source.node;
      return exact && n.type === 'step' && CODE_CHANGING_STEPS.has(n.step)
        ? undefined
        : {
            code: 'CODE_RESULT_FORGED',
            message: `stores into '${path}', which only an implementation or fix step may fill`,
          };
    }
    const b = source.binding;
    if (exact && bindingKind(b) === 'from' && (b as { default?: unknown }).default === undefined) {
      const id = nodeOutputId((b as { from: string }).from);
      const node = id === undefined ? undefined : spec.nodes[id];
      if (
        id !== undefined &&
        (b as { from: string }).from === `nodes.${id}.output` &&
        node?.type === 'step' &&
        CODE_CHANGING_STEPS.has(node.step)
      ) {
        return undefined;
      }
    }
    return {
      code: 'CODE_RESULT_FORGED',
      message: `sets '${path}'; it may only adopt the output of an implementation or fix step (from nodes.<step>.output)`,
    };
  }

  const derivedKey = Object.keys(DERIVED_PATHS).find((p) => under(path, p));
  if (derivedKey === undefined) {
    return {
      code: 'CONTEXT_WRITE_DENIED',
      message: `writes '${path}', which is not a path a generated plan may write; use '${SCRATCH_PREFIX}.*' for working values`,
    };
  }
  const plumbing = DERIVED_PATHS[derivedKey] as Plumbing;
  if (source.kind === 'storeAs') {
    if (plumbing.field !== undefined) {
      return {
        code: 'CONTEXT_WRITE_DENIED',
        message: `stores a whole node output into '${path}'; it takes only the '${plumbing.field}' field of ${describeSources(plumbing)}, copied with a set node from nodes.<id>.output.${plumbing.field}`,
      };
    }
    return sourceAllowed(plumbing, source.node)
      ? undefined
      : {
          code: 'CONTEXT_WRITE_DENIED',
          message: `stores ${describeNode(source.node)} into '${path}', which only ${describeSources(plumbing)} may fill`,
        };
  }
  const b = source.binding;
  const kind = bindingKind(b);
  if (kind === 'literal') {
    const v = (b as { literal: unknown }).literal;
    return plumbing.clearable && (v === null || v === '')
      ? undefined
      : {
          code: 'CONTEXT_WRITE_DENIED',
          message: `sets '${path}' to a literal; it may only be copied from a node's output${plumbing.clearable ? ' or cleared' : ''}`,
        };
  }
  if (kind === 'from') {
    const { from, default: dflt } = b as { from: string; default?: unknown };
    const id = isSafePath(from) ? nodeOutputId(from) : undefined;
    const node = id === undefined ? undefined : spec.nodes[id];
    if (node === undefined || !sourceAllowed(plumbing, node)) {
      return {
        code: 'CONTEXT_WRITE_DENIED',
        message: `sets '${path}' from '${from}'; it may only be copied from the output of ${describeSources(plumbing)}`,
      };
    }
    if (plumbing.field !== undefined && from !== `nodes.${id}.output.${plumbing.field}`) {
      return {
        code: 'CONTEXT_WRITE_DENIED',
        message: `sets '${path}' from '${from}'; it takes exactly nodes.<id>.output.${plumbing.field}, the field the platform fills it from`,
      };
    }
    if (dflt !== undefined && ![null, '', []].some((empty) => sameJson(empty, dflt))) {
      return {
        code: 'CONTEXT_WRITE_DENIED',
        message: `sets '${path}' with a non-empty default, which stands in for the node's output when it is missing`,
      };
    }
    return undefined;
  }
  return {
    code: 'CONTEXT_WRITE_DENIED',
    message: `sets '${path}' with ${kind === 'expr' ? 'an expression' : 'an ambiguous binding'}; it may only be copied from a node's output`,
  };
}

/**
 * Domain statuses a node may stamp on entry: any but the vocabulary that ends a run. Stamping
 * `COMPLETED` on the way would show a running plan as over.
 */
const TERMINAL_STATUS_WORDS: ReadonlySet<string> = new Set([
  'CANCELLED',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'SUCCESS',
  'TIMED_OUT',
]);

export function isTerminalStatusWord(status: string): boolean {
  return TERMINAL_STATUS_WORDS.has(status.trim().toUpperCase());
}

/**
 * The domain statuses a node outside the core may stamp. Readers act on the others: the dashboard's
 * needs-merge list, review fixes and PR feedback key on `AWAITING_HUMAN_MERGE`, and the core stamps
 * `IMPLEMENTING`, `IN_REVIEW`, `AWAITING_CI` and `AWAITING_HUMAN_MERGE` itself. A free node that
 * stamped one would show a run as waiting for a merge it never reached. `canonicalCore.test.ts`
 * proves this set shares no word with the statuses the canonical core stamps.
 */
export const FREE_STATUS_ALLOWLIST: ReadonlySet<string> = new Set([
  'PLANNING',
  'VALIDATING_CONTEXT',
]);

/** Why a free node may not stamp `status`, or `undefined` when it may. */
export function freeStatusRefusal(status: string): string | undefined {
  return FREE_STATUS_ALLOWLIST.has(status)
    ? undefined
    : `stamps the status '${status}'; outside the core a node may stamp only ${[...FREE_STATUS_ALLOWLIST].map((s) => `'${s}'`).join(' or ')}, because other words are read as the run having reached that stage`;
}
