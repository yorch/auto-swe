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

export const SPEC_SCHEMA_VERSION = 4 as const;

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
 * HITL — `humanApproval`: pause the workflow and ask a human to approve or reject.
 * The Temporal signal name is `hitl_${nodeId}`.
 */
const HumanApprovalNodeSchema = z.object({
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
  SetNodeSchema,
  CondNodeSchema,
  SignalNodeSchema,
  TerminateNodeSchema,
  FanOutNodeSchema,
  ShellNodeSchema,
  HumanApprovalNodeSchema,
  HumanDecisionNodeSchema,
  HumanInputNodeSchema,
  HumanReviewNodeSchema,
]);
export type Node = z.infer<typeof NodeSchema>;
export type StepNode = z.infer<typeof StepNodeSchema>;
export type SetNode = z.infer<typeof SetNodeSchema>;
export type CondNode = z.infer<typeof CondNodeSchema>;
export type SignalNode = z.infer<typeof SignalNodeSchema>;
export type TerminateNode = z.infer<typeof TerminateNodeSchema>;
export type FanOutNode = z.infer<typeof FanOutNodeSchema>;
export type ShellNode = z.infer<typeof ShellNodeSchema>;
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
    const isNodeId = (id: string | undefined): id is string =>
      typeof id === 'string' && id in spec.nodes;
    for (const [id, node] of Object.entries(spec.nodes)) {
      const refs: Array<[string, string | undefined]> = [];
      switch (node.type) {
        case 'step':
        case 'set':
        case 'shell':
          refs.push(['next', node.next]);
          break;
        case 'cond':
          refs.push(['onTrue', node.onTrue], ['onFalse', node.onFalse]);
          break;
        case 'signal':
          refs.push(['onReceive', node.onReceive], ['onTimeout', node.onTimeout]);
          break;
        case 'terminate':
          break;
        case 'fanOut':
          refs.push(['subgraph', node.subgraph], ['join', node.join]);
          break;
        case 'humanApproval':
          refs.push(['onApprove', node.onApprove], ['onReject', node.onReject], ['onTimeout', node.onTimeout]);
          break;
        case 'humanDecision':
          refs.push(['onTimeout', node.onTimeout]);
          for (const [i, opt] of node.options.entries()) {
            refs.push([`options[${i}].next`, opt.next]);
          }
          break;
        case 'humanInput':
          refs.push(['onSubmit', node.onSubmit], ['onTimeout', node.onTimeout]);
          break;
        case 'humanReview':
          refs.push(['onSubmit', node.onSubmit], ['onTimeout', node.onTimeout]);
          break;
      }
      for (const [field, ref] of refs) {
        if (ref !== undefined && !isNodeId(ref)) {
          ctx.addIssue({
            code: 'custom',
            message: `node '${id}'.${field} refers to unknown node '${ref}'`,
            path: ['nodes', id, field],
          });
        }
      }
    }
  });

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

/** Validate + parse an unknown into a typed WorkflowSpec. Throws on error. */
export function parseWorkflowSpec(input: unknown): WorkflowSpec {
  return WorkflowSpecSchema.parse(input);
}
