import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STEP_REQUIRED_AGENTS } from './stepRequiredAgents.js';

/**
 * `STEP_REQUIRED_AGENTS` carries a "keep this in sync with `STEP_EXECUTORS`"
 * instruction and, until now, nothing that checked it.
 *
 * That got materially more dangerous when the boot gate started deriving
 * itself from this map: a step renamed or deleted in `runnable.ts` leaves a
 * stale key here, and a *new* model-resolving step with no key means the agent
 * it needs is never checked at boot — the run fails mid-flight with
 * `ConfigMissingError`, which is precisely what `assertConfigReady` exists to
 * prevent.
 *
 * "This step resolves a model" is not syntactic, so full derivation is out.
 * What is checkable is the direction that actually rots: every key here must
 * name a step that still exists.
 */

const RUNNABLE_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../workflows/runnable.ts'),
  'utf8'
);

/** Step names registered in `runnable.ts`'s executor table: `['name', async …`. */
function registeredStepNames(): Set<string> {
  const names = new Set<string>();
  for (const m of RUNNABLE_SRC.matchAll(/^\s*'([a-zA-Z][\w]*)',\s*$/gm)) {
    names.add(m[1]);
  }
  return names;
}

describe('STEP_REQUIRED_AGENTS tracks the step executors', () => {
  const registered = registeredStepNames();

  it('finds the executor table (the parser itself works)', () => {
    // Without this the assertion below passes vacuously on any parser drift.
    expect(registered.size).toBeGreaterThan(15);
    expect(registered).toContain('executeImplementation');
    expect(registered).toContain('runReviewNetwork');
  });

  it('names only steps that still exist', () => {
    const stale = Object.keys(STEP_REQUIRED_AGENTS).filter((step) => !registered.has(step));
    expect(stale, 'steps in STEP_REQUIRED_AGENTS with no executor in runnable.ts').toEqual([]);
  });
});
