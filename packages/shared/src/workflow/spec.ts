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
 * Phase 6+ adds: shell.
 */

export const SPEC_SCHEMA_VERSION = 3 as const;

const NodeIdSchema = z.string().min(1).max(64);

/** A binding reads a value from the run context. */
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
  status: z.enum(['SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED']),
  type: z.literal('terminate'),
});

/**
 * Phase 3 — fan-out / parallel subagents.
 *
 * `fanOut` evaluates `over` to an array and runs the subgraph (entered at the
 * node id in `subgraph`) once per element. Each branch executes in a sealed
 * **child context**: a frozen copy of the parent plus `[itemKey]: <element>`
 * and a freshly initialized `nodes:{}` / `context:{}` for branch-local writes.
 *
 * A branch terminates when it reaches a `terminate` node (the branch result is
 * captured rather than ending the whole run). After all branches finish, the
 * parent context is updated with:
 *
 *   nodes.<fanOutId>.output = {
 *     count, results: [{ status, result, exports? }, …],
 *     failed: number, succeeded: number
 *   }
 *
 * and execution continues at `join`. If `exports` is set, each entry's
 * `exports` field is populated with the listed child-context paths.
 *
 * Phase 3 ships sequential execution (`concurrency` is reserved for the
 * follow-up that adds Promise.all-with-limit).
 */
const FanOutNodeSchema = z.object({
  /** Optional dot-path exports lifted from each branch's child context. */
  exports: z.array(z.string().min(1).max(120)).max(20).optional(),
  /** Key under which each element is bound in the branch's child context. */
  itemKey: z.string().min(1).max(64).default('subtask'),
  /** NodeId to resume at once every branch has finished. */
  join: NodeIdSchema,
  /** When true, a single failed branch still allows the parent to continue. */
  onBranchFail: z.enum(['block', 'continue']).default('block'),
  /** Binding that must resolve to an array (or an iterable of plain values). */
  over: BindingSchema,
  /** Entry NodeId of the per-element subgraph. */
  subgraph: NodeIdSchema,
  type: z.literal('fanOut'),
});

export const NodeSchema = z.discriminatedUnion('type', [
  StepNodeSchema,
  SetNodeSchema,
  CondNodeSchema,
  SignalNodeSchema,
  TerminateNodeSchema,
  FanOutNodeSchema,
]);
export type Node = z.infer<typeof NodeSchema>;
export type StepNode = z.infer<typeof StepNodeSchema>;
export type SetNode = z.infer<typeof SetNodeSchema>;
export type CondNode = z.infer<typeof CondNodeSchema>;
export type SignalNode = z.infer<typeof SignalNodeSchema>;
export type TerminateNode = z.infer<typeof TerminateNodeSchema>;
export type FanOutNode = z.infer<typeof FanOutNodeSchema>;

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
