import { createHash } from 'node:crypto';
import { stableStringify } from '../../lib/stableJson.js';
import { buildCanonicalCore } from './canonicalCore.js';
import {
  RUN_PLAN_DENIED_NODE_TYPES,
  RUN_PLAN_DENIED_STEPS,
  RUN_PLAN_FREE_STEPS,
  RUN_PLAN_SKELETON_STEPS,
} from './stepAllowlist.js';

/**
 * Fingerprint of everything a plan was generated against that lives in code: the step allowlist
 * (free, skeleton and denied steps, denied node types) and the canonical core's own nodes. A
 * plan records it when it is built (`RunPlan.catalogHash`); approval recomputes it and refuses a
 * plan whose generator saw a different catalog, because such a plan was written against rules this
 * deployment no longer has. Deliberately not a proof of anything on its own: approval and the
 * worker re-run the policy itself, and this only turns "the rules moved under a pending plan" into
 * an explicit refusal rather than a plan that happens to still pass.
 */
export function runPlanCatalogHash(): string {
  const core = buildCanonicalCore();
  const fingerprint = {
    core,
    deniedNodeTypes: Object.keys(RUN_PLAN_DENIED_NODE_TYPES).sort(),
    deniedSteps: Object.keys(RUN_PLAN_DENIED_STEPS).sort(),
    freeSteps: [...RUN_PLAN_FREE_STEPS].sort(),
    skeletonSteps: [...RUN_PLAN_SKELETON_STEPS].sort(),
  };
  return createHash('sha256').update(stableStringify(fingerprint)).digest('hex');
}
