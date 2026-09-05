/**
 * Static spec-level cost estimator. Walks a `WorkflowSpec`, sums each step's
 * `costHint.tokensIn` × input price + `costHint.tokensOut` × output price, and
 * returns the projected USD per run.
 *
 * Estimation is intentionally rough:
 *   - Branching nodes (`cond`, `signal`) take the **max** of both arms — a
 *     pessimistic worst-case so users see the upper bound, not an average.
 *   - `fanOut` multiplies the subgraph's estimate by an assumed mean width
 *     (default 4, same as `DEFAULT_FANOUT_CONCURRENCY`). The actual width is
 *     only known at runtime from the planner's output, so the displayed
 *     number is a planning aid, not an invoice.
 *   - Nodes without a `costHint` contribute zero (consistent with the existing
 *     palette behavior).
 *   - Each node's downstream cost is memoised, so a node reached by several
 *     arms (a diamond) counts fully in every arm and the max is the true worst
 *     case regardless of which arm is walked first. Cycles (cond → back-edge)
 *     are cut by the walk stack, so a step in a retry loop is counted once; a
 *     `Repository`-configured "retry budget" could multiply it once that
 *     signal exists.
 */
import type { Node, StepMetadata, WorkflowSpec } from './index.js';

export type CostRole = NonNullable<NonNullable<StepMetadata['costHint']>['role']>;

/**
 * USD per 1M tokens by role. Rough mid-market priced as of model-pricing
 * snapshot in Q1 2026 — Opus 4.8 for implementer/reviewer roles, Sonnet 4.6
 * for planner/validateContext/commitToMemory, Haiku 4.5 for the eval judge.
 * Override at call time if a team wants their own pricing table.
 */
export const DEFAULT_ROLE_PRICING: Record<
  CostRole,
  { inputUsdPerM: number; outputUsdPerM: number }
> = {
  commitToMemory: { inputUsdPerM: 3, outputUsdPerM: 15 },
  evalJudge: { inputUsdPerM: 1, outputUsdPerM: 5 },
  implementer: { inputUsdPerM: 15, outputUsdPerM: 75 },
  planner: { inputUsdPerM: 3, outputUsdPerM: 15 },
  reviewer: { inputUsdPerM: 15, outputUsdPerM: 75 },
  securityReview: { inputUsdPerM: 15, outputUsdPerM: 75 },
  validateContext: { inputUsdPerM: 3, outputUsdPerM: 15 },
};

export const DEFAULT_FANOUT_WIDTH = 4;

export interface CostEstimate {
  totalUsd: number;
  perStep: Array<{ nodeId: string; step: string; usd: number }>;
  fanOutWidthAssumed: number;
}

interface EstimatorOptions {
  pricing?: Partial<Record<CostRole, { inputUsdPerM: number; outputUsdPerM: number }>>;
  /** How wide we assume each `fanOut` runs. Defaults to `DEFAULT_FANOUT_WIDTH`. */
  fanOutWidth?: number;
  /** Step name → metadata. Lets web/gateway pass in their (possibly extended) registry. */
  stepLookup: (name: string) => StepMetadata | undefined;
}

function stepUsd(meta: StepMetadata | undefined, pricing: typeof DEFAULT_ROLE_PRICING): number {
  const hint = meta?.costHint;
  if (!hint?.role) {
    return 0;
  }
  const rates = pricing[hint.role];
  if (!rates) {
    return 0;
  }
  const inUsd = ((hint.tokensIn ?? 0) / 1_000_000) * rates.inputUsdPerM;
  const outUsd = ((hint.tokensOut ?? 0) / 1_000_000) * rates.outputUsdPerM;
  return inUsd + outUsd;
}

export function estimateSpecCost(spec: WorkflowSpec, options: EstimatorOptions): CostEstimate {
  const pricing = { ...DEFAULT_ROLE_PRICING, ...(options.pricing ?? {}) };
  const fanOutWidth = options.fanOutWidth ?? DEFAULT_FANOUT_WIDTH;
  const perStep: CostEstimate['perStep'] = [];

  // Per-node USD, recursive walker memoised per node. A plain visited set
  // made the branch max order-dependent: the second arm to reach a shared
  // join saw it as "already counted" and came back cheaper than it is. The
  // walk stack (not the memo) breaks cycles, so a back-edge contributes zero
  // while every other path to a node gets its full cost. We capture both the
  // total and the per-step breakdown so the editor can surface a tooltip /
  // drill-down later; each node is pushed once, on first computation.
  const memo = new Map<string, number>();
  const onStack = new Set<string>();
  const walk = (nodeId: string | undefined): number => {
    if (!nodeId) {
      return 0;
    }
    const known = memo.get(nodeId);
    if (known !== undefined) {
      return known;
    }
    if (onStack.has(nodeId)) {
      return 0;
    }
    const node = spec.nodes[nodeId] as Node | undefined;
    if (!node) {
      return 0;
    }
    onStack.add(nodeId);
    const usd = costOf(nodeId, node);
    onStack.delete(nodeId);
    memo.set(nodeId, usd);
    return usd;
  };
  const costOf = (nodeId: string, node: Node): number => {
    switch (node.type) {
      case 'step': {
        const meta = options.stepLookup(node.step);
        const usd = stepUsd(meta, pricing);
        if (usd > 0) {
          perStep.push({ nodeId, step: node.step, usd });
        }
        return usd + walk(node.next);
      }
      case 'agent': {
        // Cost depends on the referenced Agent (dynamic); use the node's step
        // metadata if it carries a cost hint, otherwise just walk onward.
        const meta = options.stepLookup('runAgentNode');
        const usd = stepUsd(meta, pricing);
        if (usd > 0) {
          perStep.push({ nodeId, step: 'runAgentNode', usd });
        }
        return usd + walk(node.next);
      }
      case 'mcp':
        // External MCP tool call — no token-based cost modeled here.
        return walk(node.next);
      case 'eval': {
        // Evals node: the judge scorer (if any) makes one LLM call; model it via
        // the runEvalNode step metadata when present, else just walk onward.
        const meta = options.stepLookup('runEvalNode');
        const usd = stepUsd(meta, pricing);
        if (usd > 0) {
          perStep.push({ nodeId, step: 'runEvalNode', usd });
        }
        return usd + walk(node.next);
      }
      case 'containerStep':
        // Coded container step — container runtime cost, not token-based.
        return walk(node.next);
      case 'set':
        return walk(node.next);
      case 'cond':
        return Math.max(walk(node.onTrue), walk(node.onFalse));
      case 'signal':
        return Math.max(walk(node.onReceive), walk(node.onTimeout));
      case 'fanOut':
        return walk(node.subgraph) * fanOutWidth + walk(node.join);
      case 'shell':
        // Shell steps don't have a token-based cost. They incur container
        // runtime cost instead, which we don't model here.
        return walk(node.next);
      case 'terminate':
        return 0;
      case 'humanApproval':
        // HITL nodes don't have a token-based cost on their own.
        return Math.max(walk(node.onApprove), walk(node.onReject), walk(node.onTimeout));
      case 'humanDecision': {
        const optionCosts = node.options.map((o) => walk(o.next));
        return Math.max(walk(node.onTimeout), ...optionCosts);
      }
      case 'humanInput':
        return Math.max(walk(node.onSubmit), walk(node.onTimeout));
      case 'humanReview':
        return Math.max(walk(node.onSubmit), walk(node.onTimeout));
    }
  };

  const totalUsd = walk(spec.entry);
  return { fanOutWidthAssumed: fanOutWidth, perStep, totalUsd };
}
