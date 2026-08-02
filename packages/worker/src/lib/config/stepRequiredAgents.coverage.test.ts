import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STEP_REQUIRED_AGENTS } from './stepRequiredAgents.js';

/**
 * `STEP_REQUIRED_AGENTS` is hand-maintained, carries a "keep this in sync with
 * `STEP_EXECUTORS`" instruction, and is the sole input to the boot gate —
 * `requiredAgentKeysForDeployment` maps installed templates' step nodes through
 * it. Two directions can rot:
 *
 *  - a **stale key**, naming a step that no longer exists. Checked here.
 *  - a **missing key** for a step that resolves a model. Checked at runtime by
 *    `recordLlmUsage`, which is the only place that knows both the executing
 *    activity and the agent key it just spent tokens on.
 *
 * The missing-key direction deliberately is *not* inferred statically. The
 * obvious approach — walk a step's activity module and its imports looking for
 * `recordLlmUsage` — over-approximates badly, because one module hosts several
 * activities: `qualityGates.ts` imports `implementerSession` for the gate-fix
 * loop, so `runLint` "reaches" LLM usage it never performs. Narrowing that to
 * real call-graph analysis is far more machinery than the check is worth when
 * one runtime assertion answers it exactly.
 */

const WORKER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNABLE = join(WORKER_SRC, 'workflows/runnable.ts');

/**
 * Step names registered in `STEP_EXECUTORS`.
 *
 * Entries come in two shapes — multi-line with an inline arrow, and single-line
 * sharing a helper (`['runTests', gateExecutor]`) — so match the leading name
 * token rather than trying to bracket a whole entry. An earlier version keyed
 * off the closing `],` and silently dropped every single-line entry, which took
 * `planDecomposition` with it.
 */
function registeredSteps(): Set<string> {
  const src = readFileSync(RUNNABLE, 'utf8');
  const table = src.slice(src.indexOf('const STEP_EXECUTORS'), src.indexOf('\n]);'));
  return new Set(
    [...table.matchAll(/\[\s*(?:\/\/[^\n]*\n\s*)*'([a-zA-Z]\w*)'\s*,/g)].map((m) => m[1])
  );
}

describe('STEP_REQUIRED_AGENTS tracks the step executors', () => {
  const steps = registeredSteps();

  it('finds the executor table (the parser itself works)', () => {
    // Without this every assertion below passes vacuously on parser drift.
    expect(steps.size).toBeGreaterThan(20);
    // One of each entry shape, so dropping either is caught.
    expect(steps).toContain('executeImplementation'); // multi-line
    expect(steps).toContain('runTests'); // single-line, shared executor
    expect(steps).toContain('planDecomposition');
  });

  it('names only steps that still exist', () => {
    const stale = Object.keys(STEP_REQUIRED_AGENTS).filter((step) => !steps.has(step));
    expect(stale, 'keys in STEP_REQUIRED_AGENTS with no executor in runnable.ts').toEqual([]);
  });

  it('marks a dynamic step rather than leaving it undeclared', () => {
    // `runAgentNode` binds an `agentRef` from the spec, so it can never carry a
    // key list — but leaving it out of the map entirely is indistinguishable
    // from drift, and `flagUnregisteredAgentUsage` would warn on every run.
    expect(STEP_REQUIRED_AGENTS).toHaveProperty('runAgentNode');
    expect(STEP_REQUIRED_AGENTS.runAgentNode).toBeNull();
  });

  it('declares agent lists as arrays, never a bare string', () => {
    // A string value would satisfy `readonly string[] | null` at no type error
    // if it were ever widened, and `for (const key of declared)` would then add
    // its individual characters to the boot gate. Cheap to assert, silent to
    // debug otherwise.
    for (const [step, declared] of Object.entries(STEP_REQUIRED_AGENTS)) {
      if (declared !== null) {
        expect(Array.isArray(declared), `${step} must declare an array`).toBe(true);
      }
    }
  });
});
