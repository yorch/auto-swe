/**
 * Cost estimate for a plan preview: a thin wrapper over {@link estimateSpecCost} with the real step
 * registry bound in. It adds no pricing logic. The number is a floor, not a forecast: nodes with no
 * cost hint (agent nodes, containers, MCP calls) are listed in `unpriced` rather than costed, a
 * fan-out is costed at an assumed width, and loops and retries are counted once.
 */

import {
  type CostEstimate,
  type CostRole,
  describeCostExclusions,
  estimateSpecCost,
} from '../costEstimator.js';
import type { WorkflowSpec } from '../spec.js';
import { getStepMetadata, hasStep } from '../stepRegistry.js';

export interface RunPlanCostEstimate {
  totalUsd: CostEstimate['totalUsd'];
  perStep: CostEstimate['perStep'];
  unpriced: CostEstimate['unpriced'];
  fanOutWidthAssumed: CostEstimate['fanOutWidthAssumed'];
  /** One sentence saying what the number leaves out, for display beside it. */
  exclusions: string;
}

export interface RunPlanCostOptions {
  /** Live per-role prices (USD per million tokens); defaults to the built-in role prices. */
  pricing?: Partial<Record<CostRole, { inputUsdPerM: number; outputUsdPerM: number }>>;
  /** How wide each fan-out is assumed to run. */
  fanOutWidth?: number;
}

export function estimateRunPlanCost(
  spec: WorkflowSpec,
  options: RunPlanCostOptions = {}
): RunPlanCostEstimate {
  const estimate = estimateSpecCost(spec, {
    ...options,
    stepLookup: (name) => (hasStep(name) ? getStepMetadata(name) : undefined),
  });
  return {
    exclusions: describeCostExclusions(estimate),
    fanOutWidthAssumed: estimate.fanOutWidthAssumed,
    perStep: estimate.perStep,
    totalUsd: estimate.totalUsd,
    unpriced: estimate.unpriced,
  };
}
