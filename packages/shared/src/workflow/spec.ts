import { z } from 'zod';

/**
 * WorkflowSpec — a serializable, versioned DAG that the RunnableWorkflow
 * interpreter executes. Stored as JSON in WorkflowTemplateVersion.spec.
 *
 * Phase 1 node types cover the existing hardcoded EngineeringWorkflow:
 *   - step      : run a registered activity
 *   - set       : write values into the run context
 *   - cond      : branch on a jsonpath/comparison expression
 *   - signal    : wait for a Temporal signal with timeout
 *   - terminate : end the run with a status
 *
 * Phase 2+ adds: fanOut, joinAll, gate, shell, loop, conditional retry.
 */

export const SPEC_SCHEMA_VERSION = 1 as const;

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

const StepNodeSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  heartbeatTimeout: z.string().optional(),
  inputs: InputMapSchema.optional(),
  next: NodeIdSchema.optional(),
  onError: OnErrorSchema.optional(),
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

export const NodeSchema = z.discriminatedUnion('type', [
  StepNodeSchema,
  SetNodeSchema,
  CondNodeSchema,
  SignalNodeSchema,
  TerminateNodeSchema,
]);
export type Node = z.infer<typeof NodeSchema>;
export type StepNode = z.infer<typeof StepNodeSchema>;
export type SetNode = z.infer<typeof SetNodeSchema>;
export type CondNode = z.infer<typeof CondNodeSchema>;
export type SignalNode = z.infer<typeof SignalNodeSchema>;
export type TerminateNode = z.infer<typeof TerminateNodeSchema>;

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
