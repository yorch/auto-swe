import { z } from 'zod';

/**
 * WorkflowSpec — a serializable, versioned graph that the RunnableWorkflow
 * interpreter executes. Stored as JSON in WorkflowTemplateVersion.spec.
 *
 * The graph is intentionally not acyclic — `cond` edges may form back-edges
 * to express loops (e.g. the retry-on-failure loop in the seeded default
 * engineering spec). The interpreter caps the total node-transition count
 * (DEFAULT_MAX_TRANSITIONS) to prevent runaway specs from looping forever.
 *
 * Phase 1 node types cover the existing hardcoded EngineeringWorkflow:
 *   - step      : run a registered activity
 *   - set       : write values into the run context
 *   - cond      : branch on a jsonpath/comparison expression
 *   - signal    : wait for a Temporal signal with timeout
 *   - terminate : end the run with a status
 *
 * Phase 2 extends step nodes with `onFail` modes (block / warn / retry).
 * Phase 3 adds:
 *   - fanOut    : run a subgraph once per item in an iterable, then join
 * Phase 6 adds:
 *   - shell     : run a user-authored command in an ephemeral container
 *                 (separate from the long-lived workspace; gated by RBAC +
 *                 image allowlist; per-step network mode).
 */

export const SPEC_SCHEMA_VERSION = 1 as const;

const NodeIdSchema = z.string().min(1).max(64);

/** A binding reads a value from the run context. Conventionally exactly one of
 *  `from` / `literal` / `expr` is present; an ambiguous object resolves to
 *  whichever union member zod matches first. Kept non-strict on purpose so
 *  already-stored specs (re-parsed at run time) with incidental extra keys
 *  don't fail to load. */
export const BindingSchema = z.union([
  z.object({
    default: z.unknown().optional(),
    from: z.string().min(1),
  }),
  z.object({ literal: z.unknown() }),
  z.object({ expr: z.string().min(1) }),
]);
export type Binding = z.infer<typeof BindingSchema>;

const InputMapSchema = z.record(z.string(), BindingSchema);

const RetryPolicySchema = z
  .object({
    backoffCoefficient: z.number().min(1).max(10).default(2),
    initialInterval: z.string().default('1s'),
    maximumAttempts: z.number().int().min(1).max(20).default(1),
    maximumInterval: z.string().default('1m'),
  })
  .partial()
  .optional();

const OnErrorSchema = z.enum(['fail', 'continue']).default('fail');

/**
 * Per-step failure policy (phase 2). Layered on top of activity-level retry:
 *   - `block`        : a failure terminates the run with FAILED (default)
 *   - `warn`         : record FAILED, then continue via `next`
 *   - `{ retry: N }` : re-run the step up to N additional times; after the
 *                      final attempt fails, fall back to `block` semantics
 *
 * Use this for workflow-level failure handling. Activity-level retry policy
 * (transient infra/IO errors) still lives on the `retry` field.
 */
const OnFailSchema = z.union([
  z.literal('block'),
  z.literal('warn'),
  z.object({ retry: z.number().int().min(1).max(10) }),
]);
export type OnFailMode = z.infer<typeof OnFailSchema>;

const StepNodeSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  heartbeatTimeout: z.string().optional(),
  inputs: InputMapSchema.optional(),
  next: NodeIdSchema.optional(),
  onError: OnErrorSchema.optional(),
  onFail: OnFailSchema.optional(),
  retry: RetryPolicySchema,
  startToCloseTimeout: z.string().optional(),
  step: z.string().min(1),
  type: z.literal('step'),
});

/**
 * Declarative agent node (P2). Runs a library Agent by reference
 * (`agentRef` = `"<key>"` float or `"<key>@<version>"` pin) — the worker
 * resolves it via `resolveAgentSpec`/`resolveAgent` and runs it through
 * `runAgent`. The agent's output is recorded at `nodes.<id>.output` like any
 * step. `userMessage` is the literal prompt payload; when omitted the worker
 * uses the resolved `inputs` (JSON) as the message.
 */
const AgentNodeSchema = z.object({
  agentRef: z.string().min(1),
  heartbeatTimeout: z.string().optional(),
  inputs: InputMapSchema.optional(),
  next: NodeIdSchema.optional(),
  onError: OnErrorSchema.optional(),
  onFail: OnFailSchema.optional(),
  retry: RetryPolicySchema,
  spanName: z.string().optional(),
  startToCloseTimeout: z.string().optional(),
  /** Per-node system-prompt override (wins over the Agent's own prompt). */
  systemPrompt: z.string().optional(),
  type: z.literal('agent'),
  userMessage: z.string().optional(),
});

/**
 * Declarative MCP node (P2/WS4). Calls a single tool on an `mcp` Connection as a
 * workflow step: `connectionRef` is the `mcp` Connection id, `tool` is the tool
 * name on that server, and `inputs` map to the tool's arguments. The tool result
 * is recorded at `nodes.<id>.output.result` like any step output.
 */
const McpNodeSchema = z.object({
  /** Id of an `mcp`-type Connection (its `config.url` is the server). */
  connectionRef: z.string().min(1),
  heartbeatTimeout: z.string().optional(),
  inputs: InputMapSchema.optional(),
  next: NodeIdSchema.optional(),
  onError: OnErrorSchema.optional(),
  onFail: OnFailSchema.optional(),
  retry: RetryPolicySchema,
  spanName: z.string().optional(),
  startToCloseTimeout: z.string().optional(),
  /** Name of the MCP tool to invoke on the server. */
  tool: z.string().min(1),
  type: z.literal('mcp'),
});

/**
 * Declarative `eval` node (P2; docs/evals-p2.md). Scores a target value already
 * in the run context with a list of scorers and records the result. Floor
 * scorers (`gate`/`assert`) run first and short-circuit the judge on failure
 * (the combination model — RFC §2); soft scorers (`trajectory`/`judge`) are
 * advisory. The worker's `runEvalNode` executor evaluates them and binds an
 * aggregate at `nodes.<id>.output.score` for downstream `cond` branching.
 */
const EvalScorerSchema = z.discriminatedUnion('kind', [
  z.object({ command: z.string().optional(), gate: z.string().min(1), kind: z.literal('gate') }),
  z.object({ expr: z.string().min(1), kind: z.literal('assert') }),
  z.object({ from: z.string().optional(), kind: z.literal('trajectory') }),
  z.object({
    baselineFrom: z.string().optional(),
    kind: z.literal('judge'),
    rubricRef: z.string().min(1),
  }),
]);

const EvalNodeSchema = z.object({
  heartbeatTimeout: z.string().optional(),
  inputs: InputMapSchema.optional(),
  /** When false, a calibrated judge axis may block the gate (RFC §9). Default: advisory. */
  judgeAdvisory: z.boolean().optional(),
  next: NodeIdSchema.optional(),
  onError: OnErrorSchema.optional(),
  onFail: OnFailSchema.optional(),
  retry: RetryPolicySchema,
  scorers: z.array(EvalScorerSchema).min(1),
  spanName: z.string().optional(),
  startToCloseTimeout: z.string().optional(),
  /** Binding to the value being scored (e.g. a diff at `nodes.implement.output.diff`). */
  target: BindingSchema,
  type: z.literal('eval'),
});

const SetNodeSchema = z.object({
  next: NodeIdSchema.optional(),
  type: z.literal('set'),
  values: z.record(z.string(), BindingSchema),
});

const CondNodeSchema = z.object({
  expr: z.string().min(1),
  onFalse: NodeIdSchema,
  onTrue: NodeIdSchema,
  type: z.literal('cond'),
});

const SignalNodeSchema = z.object({
  name: z.string().min(1),
  onReceive: NodeIdSchema,
  onTimeout: NodeIdSchema,
  storeAs: z.string().min(1).optional(),
  timeout: z.string().min(1),
  type: z.literal('signal'),
});

const TerminateNodeSchema = z.object({
  result: InputMapSchema.optional(),
  // CANCELLED is intentionally omitted: it's set out-of-band by Temporal on a
  // cancellation signal, never reachable by a terminate node, so the spec can't
  // declare it even though `WorkflowRunStatus` includes it.
  status: z.enum(['SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED']),
  type: z.literal('terminate'),
});

/**
 * Phase 3 — fan-out / parallel subagents.
 *
 * `fanOut` evaluates `over` to an array and runs the subgraph (entered at the
 * node id in `subgraph`) once per element. Each branch executes in a sealed
 * **child context**: the parent's `request` and `workflow` are passed by
 * reference, `context` is shallow-cloned (so the branch can read parent
 * values but its mutations stay local), and `nodes` is reinitialized to
 * `{}`. The element is bound at `[itemKey]` and the index at `[itemKey]Index`.
 *
 * A branch terminates when it reaches a `terminate` node (the branch result is
 * captured rather than ending the whole run). After all branches finish, the
 * parent context is updated with:
 *
 *   nodes.<fanOutId>.output = {
 *     count, results: [{ status, result, exports? }, …],
 *     failed: number, succeeded: number, plucked?: unknown[]
 *   }
 *
 * and execution continues at `join`. If `exports` is set, each entry's
 * `exports` field is populated with the listed child-context paths.
 *
 * Branches run in parallel through a concurrency-bounded worker pool (phase
 * 3.5); see `concurrency` below.
 */
const FanOutNodeSchema = z.object({
  /**
   * Max number of branches to run concurrently (default 4 in the interpreter,
   * capped at 20). Enforced by the interpreter's bounded worker pool.
   */
  concurrency: z.number().int().min(1).max(20).optional(),
  /** Optional dot-path exports lifted from each branch's child context. */
  exports: z.array(z.string().min(1).max(120)).max(20).optional(),
  /** Key under which each element is bound in the branch's child context. */
  itemKey: z.string().min(1).max(64).default('subtask'),
  /** NodeId to resume at once every branch has finished. */
  join: NodeIdSchema,
  /** When true, a single failed branch still allows the parent to continue. */
  onBranchFail: z.enum(['block', 'continue']).default('block'),
  /** Binding that must resolve to a JavaScript array. */
  over: BindingSchema,
  /**
   * Optional path (relative to each branch result entry — e.g.
   * `result.branch` or `exports.someKey`) projected into `output.plucked: unknown[]`.
   * Lets downstream nodes bind directly to a flat array without a separate
   * shaping step. Skipped entries (no match) appear as `null` in the array.
   */
  pluck: z.string().min(1).max(120).optional(),
  /** Entry NodeId of the per-element subgraph. */
  subgraph: NodeIdSchema,
  type: z.literal('fanOut'),
});

/**
 * Phase 6 — `shell`: run a user-authored command in an ephemeral, locked-down
 * container (separate from the long-lived workspace used by agents + gates).
 *
 * Authoring requires the `workflow:write:shell` permission (team admin only;
 * enforced by the gateway when a template version containing a shell node is
 * saved). Every save is recorded in `WorkflowShellAudit`.
 *
 * Runtime guarantees (see packages/worker/src/lib/ephemeralContainer.ts):
 *   - Image is checked against the built-in allowlist + the team's
 *     `Team.shellImageAllowlist` additions.
 *   - `--network=none` by default; `network: 'egress'` opts the step into
 *     outbound traffic for SBOM uploads or similar.
 *   - `--read-only --tmpfs /tmp --pids-limit 256` + memory/cpu caps
 *   - Workspace bind-mounted at `/workspace` (only writable path)
 *   - No Docker socket mount, no caps, no host network
 *
 * Like step nodes, shell nodes honor `onFail` for workflow-level retry/warn
 * policy. The activity returns `{ passed, summary, exitCode, artifactId? }`
 * so the interpreter's gate-failure branch ("passed === false") fires the
 * configured failure mode without throwing.
 */
const ShellNodeSchema = z.object({
  /** Shell command run inside the container. Required; no defaults. */
  command: z.string().min(1).max(8000),
  /**
   * Optional config block. Currently used by the editor to surface the same
   * fields under `node.config` for the form-based inspector; the runtime
   * reads the typed fields below.
   */
  config: z.record(z.string(), z.unknown()).optional(),
  /** CPU cap in fractional units (Docker `--cpus`). Default 1.0. */
  cpus: z.number().min(0.1).max(8).optional(),
  /**
   * Docker image to run the command in. Must be on the team's effective
   * allowlist (built-in defaults + per-team additions) at workflow-start.
   */
  image: z.string().min(1).max(256),
  inputs: InputMapSchema.optional(),
  /** Memory cap (Docker `--memory`, e.g. "512m"). Default "512m". */
  memory: z
    .string()
    .regex(/^\d+[bkmg]?$/i, 'memory must be a Docker size literal like "512m" or "1g"')
    .optional(),
  /**
   * Network mode. `'none'` (default) blocks all traffic; `'egress'` lets the
   * step reach outbound hosts (still no inbound). Both modes drop Docker
   * socket access; there is no way to escape the container.
   */
  network: z.enum(['none', 'egress']).optional(),
  next: NodeIdSchema.optional(),
  onError: OnErrorSchema.optional(),
  onFail: OnFailSchema.optional(),
  retry: RetryPolicySchema,
  startToCloseTimeout: z.string().optional(),
  /** Wall-clock cap inside the container (ms). Default 600_000. */
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  type: z.literal('shell'),
});

/**
 * P4/WS4 — `containerStep`: a container-contract coded capability. Runs an image
 * in the same locked-down ephemeral container as `shell`, but with a structured
 * JSON contract: the node's resolved `inputs` are passed as JSON on the
 * `CONTAINER_STEP_INPUT` env var, and the container is expected to print a JSON
 * object to stdout, which is bound at `nodes.<id>.output.result`. This is how a
 * bundle ships *coded* capabilities (a connector/mechanism core lacks) without
 * untrusted code ever entering the worker process. Same image-allowlist + egress
 * + authoring RBAC + audit as `shell`.
 */
const ContainerStepNodeSchema = z.object({
  /** Optional command override (`sh -c`); defaults to the image entrypoint. */
  command: z.string().max(8000).optional(),
  cpus: z.number().min(0.1).max(8).optional(),
  /** Docker image to run; must be on the team's effective allowlist at run start. */
  image: z.string().min(1).max(256),
  inputs: InputMapSchema.optional(),
  memory: z
    .string()
    .regex(/^\d+[bkmg]?$/i, 'memory must be a Docker size literal like "512m" or "1g"')
    .optional(),
  network: z.enum(['none', 'egress']).optional(),
  next: NodeIdSchema.optional(),
  onError: OnErrorSchema.optional(),
  onFail: OnFailSchema.optional(),
  retry: RetryPolicySchema,
  /** Sidecar HTTP contract (required when transport === 'sidecar'). */
  sidecar: z
    .object({
      port: z.number().int().min(1).max(65535),
      readinessPath: z.string().max(512).optional(),
      readyTimeoutMs: z.number().int().min(1000).max(300_000).optional(),
      requestPath: z.string().max(512).optional(),
    })
    .optional(),
  startToCloseTimeout: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  /**
   * How the container returns its result (P5):
   *  - `'stdout'` (default): one JSON object printed to stdout.
   *  - `'ndjson'`: a stream of newline-delimited JSON events; the result is the
   *    last `{ type: 'result', result }` event (or last bare JSON line), and all
   *    events are exposed at `nodes.<id>.output.events`.
   *  - `'sidecar'`: the image runs as a detached HTTP server (loopback-only
   *    published port); the worker POSTs the inputs and binds the JSON response.
   *    Requires `sidecar.port`; implies bridge networking (egress allowlist applies).
   */
  transport: z.enum(['stdout', 'ndjson', 'sidecar']).optional(),
  type: z.literal('containerStep'),
});

/**
 * HITL — `humanApproval`: pause the workflow and ask a human to approve or reject.
 * The Temporal signal name is `hitl_${nodeId}`.
 */
const HumanApprovalNodeSchema = z.object({
  approverCount: BindingSchema.optional(),
  contextFrom: z.string().optional(),
  description: z.string().max(2000).optional(),
  onApprove: NodeIdSchema,
  onReject: NodeIdSchema,
  onTimeout: NodeIdSchema,
  timeout: z.string().min(1),
  title: z.string().min(1).max(200),
  type: z.literal('humanApproval'),
});

const HumanDecisionOptionSchema = z.object({
  label: z.string().min(1).max(100),
  next: NodeIdSchema,
  value: z.string().min(1).max(100),
});

/**
 * HITL — `humanDecision`: pause the workflow for a human to pick from N options (2–10).
 */
const HumanDecisionNodeSchema = z.object({
  contextFrom: z.string().optional(),
  description: z.string().max(2000).optional(),
  onTimeout: NodeIdSchema,
  options: z.array(HumanDecisionOptionSchema).min(2).max(10),
  storeAs: z.string().min(1).optional(),
  timeout: z.string().min(1),
  title: z.string().min(1).max(200),
  type: z.literal('humanDecision'),
});

const HumanInputFieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  type: z.enum(['text', 'number', 'boolean', 'select']),
});

/**
 * HITL — `humanInput`: pause the workflow and collect structured form data from a human.
 */
const HumanInputNodeSchema = z.object({
  description: z.string().max(2000).optional(),
  fields: z.array(HumanInputFieldSchema).min(1).max(20),
  onSubmit: NodeIdSchema,
  onTimeout: NodeIdSchema,
  storeAs: z.string().min(1).optional(),
  timeout: z.string().min(1),
  title: z.string().min(1).max(200),
  type: z.literal('humanInput'),
});

/**
 * HITL — `humanReview`: show content for a human to read and optionally edit before continuing.
 */
const HumanReviewNodeSchema = z.object({
  contentFrom: z.string().min(1),
  description: z.string().max(2000).optional(),
  onSubmit: NodeIdSchema,
  onTimeout: NodeIdSchema,
  storeAs: z.string().min(1).optional(),
  timeout: z.string().min(1),
  title: z.string().min(1).max(200),
  type: z.literal('humanReview'),
});

export const NodeSchema = z.discriminatedUnion('type', [
  StepNodeSchema,
  AgentNodeSchema,
  McpNodeSchema,
  EvalNodeSchema,
  SetNodeSchema,
  CondNodeSchema,
  SignalNodeSchema,
  TerminateNodeSchema,
  FanOutNodeSchema,
  ShellNodeSchema,
  ContainerStepNodeSchema,
  HumanApprovalNodeSchema,
  HumanDecisionNodeSchema,
  HumanInputNodeSchema,
  HumanReviewNodeSchema,
]);
export type Node = z.infer<typeof NodeSchema>;
export type StepNode = z.infer<typeof StepNodeSchema>;
export type AgentNode = z.infer<typeof AgentNodeSchema>;
export type McpNode = z.infer<typeof McpNodeSchema>;
export type EvalNode = z.infer<typeof EvalNodeSchema>;
export type EvalScorer = z.infer<typeof EvalScorerSchema>;
export type SetNode = z.infer<typeof SetNodeSchema>;
export type CondNode = z.infer<typeof CondNodeSchema>;
export type SignalNode = z.infer<typeof SignalNodeSchema>;
export type TerminateNode = z.infer<typeof TerminateNodeSchema>;
export type FanOutNode = z.infer<typeof FanOutNodeSchema>;
export type ShellNode = z.infer<typeof ShellNodeSchema>;
export type ContainerStepNode = z.infer<typeof ContainerStepNodeSchema>;
export type HumanApprovalNode = z.infer<typeof HumanApprovalNodeSchema>;
export type HumanDecisionNode = z.infer<typeof HumanDecisionNodeSchema>;
export type HumanInputNode = z.infer<typeof HumanInputNodeSchema>;
export type HumanReviewNode = z.infer<typeof HumanReviewNodeSchema>;

export const WorkflowSpecSchema = z
  .object({
    description: z.string().max(2000).default(''),
    entry: NodeIdSchema,
    name: z.string().min(1).max(120),
    nodes: z.record(NodeIdSchema, NodeSchema),
    schemaVersion: z.literal(SPEC_SCHEMA_VERSION),
  })
  .superRefine((spec, ctx) => {
    if (!spec.nodes[spec.entry]) {
      ctx.addIssue({
        code: 'custom',
        message: `entry node '${spec.entry}' is not in nodes map`,
        path: ['entry'],
      });
    }
    const isNodeId = (id: string): boolean => id in spec.nodes;
    for (const [id, node] of Object.entries(spec.nodes)) {
      for (const [field, ref] of nodeEdges(node)) {
        if (!isNodeId(ref)) {
          ctx.addIssue({
            code: 'custom',
            message: `node '${id}'.${field} refers to unknown node '${ref}'`,
            path: ['nodes', id, field],
          });
        }
      }
    }
  });

/**
 * Labeled outgoing edges of a node — `[field, targetNodeId]` for every present
 * edge. The single source of truth for graph traversal: used by the schema's
 * ref validation (above) and by `validateSpec`'s reachability/termination
 * analysis, so every node type's edges are enumerated in exactly one place.
 */
export function nodeEdges(node: Node): Array<[field: string, target: string]> {
  const edges: Array<[string, string]> = [];
  const add = (field: string, target: string | undefined): void => {
    if (typeof target === 'string') {
      edges.push([field, target]);
    }
  };
  switch (node.type) {
    case 'step':
    case 'agent':
    case 'mcp':
    case 'eval':
    case 'set':
    case 'shell':
    case 'containerStep':
      add('next', node.next);
      break;
    case 'cond':
      add('onTrue', node.onTrue);
      add('onFalse', node.onFalse);
      break;
    case 'signal':
      add('onReceive', node.onReceive);
      add('onTimeout', node.onTimeout);
      break;
    case 'fanOut':
      add('subgraph', node.subgraph);
      add('join', node.join);
      break;
    case 'humanApproval':
      add('onApprove', node.onApprove);
      add('onReject', node.onReject);
      add('onTimeout', node.onTimeout);
      break;
    case 'humanDecision':
      add('onTimeout', node.onTimeout);
      node.options.forEach((opt, i) => {
        add(`options[${i}].next`, opt.next);
      });
      break;
    case 'humanInput':
    case 'humanReview':
      add('onSubmit', node.onSubmit);
      add('onTimeout', node.onTimeout);
      break;
    case 'terminate':
      break;
    default: {
      // Exhaustiveness sentinel. This function is the single source of truth for
      // graph traversal, so a Node variant missing here silently reports zero
      // outgoing edges to the schema's ref validation and to validateSpec's
      // reachability analysis — an unreachable-node bug that validation calls
      // clean. Fail the build instead.
      const unhandled: never = node;
      void unhandled;
      break;
    }
  }
  return edges;
}

/**
 * The one indexed edge field `nodeEdges` emits: a `humanDecision` option's
 * `next`. Everything else it emits is a plain top-level field name.
 */
const OPTION_EDGE_FIELD = /^options\[(\d+)\]\.next$/;

/**
 * Read one outgoing edge, addressed by the same field name `nodeEdges` emits.
 *
 * Editors index into a node by that field name to show and retarget an edge.
 * Doing it with `node[field]` works for every node type except `humanDecision`,
 * whose option edges live inside an array — so it belongs here, beside the
 * function that defines the grammar, rather than in each consumer.
 */
export function readNodeEdge(node: Node, field: string): string | undefined {
  const option = OPTION_EDGE_FIELD.exec(field);
  if (option) {
    return node.type === 'humanDecision' ? node.options[Number(option[1])]?.next : undefined;
  }
  const value = (node as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Set or clear one outgoing edge, addressed by the same field name `nodeEdges`
 * emits. Returns a new node; the argument is untouched.
 *
 * Clearing an option edge is not expressible — `options[i].next` is required by
 * the schema — so a null target leaves an option alone.
 */
export function setNodeEdge(node: Node, field: string, target: string | null): Node {
  const option = OPTION_EDGE_FIELD.exec(field);
  if (option) {
    if (node.type !== 'humanDecision' || target === null) {
      return node;
    }
    const i = Number(option[1]);
    if (!node.options[i]) {
      return node;
    }
    return {
      ...node,
      options: node.options.map((opt, j) => (j === i ? { ...opt, next: target } : opt)),
    };
  }
  const next = { ...(node as unknown as Record<string, unknown>) };
  if (target === null) {
    delete next[field];
  } else {
    next[field] = target;
  }
  return next as unknown as Node;
}

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

/** Validate + parse an unknown into a typed WorkflowSpec. Throws on error. */
export function parseWorkflowSpec(input: unknown): WorkflowSpec {
  return WorkflowSpecSchema.parse(input);
}
