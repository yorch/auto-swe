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
 *   - Nodes without a `costHint` contribute zero and are listed in `unpriced`,
 *     which `describeCostExclusions` turns into the caveat shown beside the
 *     number — a partial sum should say what it leaves out.
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
 * USD per 1M tokens by role — the fallback when a caller passes no `pricing`.
 * Each is the built-in price of the model the role's seeded GLOBAL agent runs
 * (Opus 5.5 for implementer/reviewer/commitToMemory, Sonnet 5.5 for
 * planner/securityReview/validateContext, Haiku 4.5 for the eval judge);
 * `costEstimator.test.ts` fails when a seeded default or a built-in price moves
 * without this table. The workflow editor passes the live per-role prices from
 * the model catalog instead.
 */
export const DEFAULT_ROLE_PRICING: Record<
  CostRole,
  { inputUsdPerM: number; outputUsdPerM: number }
> = {
  commitToMemory: { inputUsdPerM: 4, outputUsdPerM: 20 },
  evalJudge: { inputUsdPerM: 1, outputUsdPerM: 5 },
  implementer: { inputUsdPerM: 4, outputUsdPerM: 20 },
  planner: { inputUsdPerM: 2, outputUsdPerM: 10 },
  reviewer: { inputUsdPerM: 4, outputUsdPerM: 20 },
  securityReview: { inputUsdPerM: 2, outputUsdPerM: 10 },
  validateContext: { inputUsdPerM: 2, outputUsdPerM: 10 },
};

export const DEFAULT_FANOUT_WIDTH = 4;

/**
 * Why a node contributes nothing to the estimate. Kept as a closed set so the
 * editor can render one sentence per class rather than a per-node list.
 */
export type UnpricedReason =
  /** `shell` / `containerStep`: the cost is container runtime, not tokens. */
  | 'container-runtime'
  /** `mcp`: an external tool call whose token usage we cannot see. */
  | 'external-call'
  /** A `step` / `agent` / `eval` whose step metadata carries no `costHint`. */
  | 'no-cost-hint';

export interface CostEstimate {
  totalUsd: number;
  perStep: Array<{ nodeId: string; step: string; usd: number }>;
  fanOutWidthAssumed: number;
  /**
   * Nodes this estimate did not price, and why. A partial sum presented as the
   * whole cost is worse than an acknowledged gap: an agent node with no hint
   * used to be invisible here, so a spec that was mostly agent nodes estimated
   * at zero. `describeCostExclusions` turns this into the sentence the editor
   * shows beside the number.
   */
  unpriced: Array<{ nodeId: string; reason: UnpricedReason }>;
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
  const unpriced: CostEstimate['unpriced'] = [];

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
        } else if (meta?.category === 'agent') {
          // Only a model-backed step is a *gap* when it costs nothing: a gate, a
          // VCS or a control step runs no model, so zero is the answer rather
          // than a missing hint. Reporting those would bury the real case.
          unpriced.push({ nodeId, reason: 'no-cost-hint' });
        }
        return usd + walk(node.next);
      }
      case 'agent': {
        // Cost depends on the referenced Agent (dynamic); priced from the
        // step's hint, which is an upper-bound proxy for the agent class.
        const meta = options.stepLookup('runAgentNode');
        const usd = stepUsd(meta, pricing);
        if (usd > 0) {
          perStep.push({ nodeId, step: 'runAgentNode', usd });
        } else {
          unpriced.push({ nodeId, reason: 'no-cost-hint' });
        }
        return usd + walk(node.next);
      }
      case 'mcp':
        // External MCP tool call — no token-based cost modeled here.
        unpriced.push({ nodeId, reason: 'external-call' });
        return walk(node.next);
      case 'eval': {
        // Only a `judge` scorer calls a model — one `evalJudge` call each, priced
        // from the runEvalNode step hint. Every other scorer runs no model (a
        // `gate` scorer costs container runtime, like a gate step, which is not
        // priced either), so an eval with no judge costs nothing and is not a gap.
        // Guarded: the editor estimates a spec that may not have passed the schema.
        const scorers: unknown[] = Array.isArray(node.scorers) ? node.scorers : [];
        const judges = scorers.filter(
          (s) => typeof s === 'object' && s !== null && (s as { kind?: unknown }).kind === 'judge'
        ).length;
        if (judges === 0) {
          return walk(node.next);
        }
        const usd = stepUsd(options.stepLookup('runEvalNode'), pricing) * judges;
        if (usd > 0) {
          perStep.push({ nodeId, step: 'runEvalNode', usd });
        } else {
          unpriced.push({ nodeId, reason: 'no-cost-hint' });
        }
        return usd + walk(node.next);
      }
      case 'containerStep':
        // Coded container step — container runtime cost, not token-based.
        unpriced.push({ nodeId, reason: 'container-runtime' });
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
        unpriced.push({ nodeId, reason: 'container-runtime' });
        return walk(node.next);
      case 'terminate':
        return 0;
      case 'humanApproval':
        // HITL nodes don't have a token-based cost on their own.
        return Math.max(
          walk(node.onApprove),
          walk(node.onReject),
          walk(node.onTimeout),
          ...(node.onRequestChanges ? [walk(node.onRequestChanges)] : [])
        );
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
  return { fanOutWidthAssumed: fanOutWidth, perStep, totalUsd, unpriced };
}

/**
 * One sentence naming what the estimate leaves out, for display beside the
 * number.
 *
 * The excluded classes are structural, not oversights: container steps cost
 * runtime rather than tokens, an MCP call's usage is the remote server's, and a
 * step without a `costHint` has no basis to price. Retries and loops are always
 * excluded — the walk cuts cycles rather than guessing an iteration count — so
 * that clause is present even when every node was priced, which is exactly when
 * the number looks most complete and is most likely to be read as a total.
 */
export function describeCostExclusions(estimate: CostEstimate): string {
  const count = (reason: UnpricedReason): number =>
    estimate.unpriced.filter((u) => u.reason === reason).length;
  const parts: string[] = [];
  const container = count('container-runtime');
  const external = count('external-call');
  const noHint = count('no-cost-hint');
  if (container > 0) {
    parts.push(`container runtime (${container} ${container === 1 ? 'node' : 'nodes'})`);
  }
  if (external > 0) {
    parts.push(`external calls (${external} ${external === 1 ? 'node' : 'nodes'})`);
  }
  if (noHint > 0) {
    parts.push(`unpriced steps (${noHint} ${noHint === 1 ? 'node' : 'nodes'})`);
  }
  const loops = 'Retries and loops are counted once, so a looping spec costs more than this.';
  return parts.length === 0 ? loops : `Excludes ${parts.join(', ')}. ${loops}`;
}
