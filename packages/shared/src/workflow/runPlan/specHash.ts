import { createHash } from 'node:crypto';
import { stableStringify } from '../../lib/stableJson.js';

/**
 * SHA-256 (hex) of a spec's canonical JSON: keys sorted recursively, `undefined` dropped, so the
 * hash of the object a generator built equals the hash of the same spec read back from a JSON
 * column. Stored as `RunPlan.specHash` at creation and compared again when a plan is approved and
 * when the worker pins it, so a spec edited in the database between the three is refused.
 */
export function hashRunPlanSpec(spec: unknown): string {
  return createHash('sha256').update(stableStringify(spec)).digest('hex');
}
