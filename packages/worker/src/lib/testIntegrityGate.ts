import {
  analyseTestIntegrity,
  summariseTestIntegrity,
  TEST_INTEGRITY_GUARD_EVENT,
  type TestIntegrityFinding,
} from '@auto-swe/shared/lib/testIntegrity';
import { ApplicationFailure } from '@temporalio/activity';
import type { AgentTracer } from './agentTracer.js';

export type TestIntegrityGuardMode = 'off' | 'warn' | 'block';

export interface TestIntegrityGateInput {
  mode: TestIntegrityGuardMode;
  /** The change the fixer made, as a unified diff, read before anything is committed or pushed. */
  readDiff: () => Promise<string>;
  tracer: AgentTracer;
}

/**
 * The test-integrity gate of the CI-fix session: did the fixer reach green by deleting, skipping
 * or weakening tests? Runs on the fixer's diff after the agent and before the commit and push, so
 * a block leaves nothing on the branch.
 *
 *  - `off`   -> not read, nothing recorded.
 *  - `warn`  -> a trip is recorded as a `ci_fix.test_integrity_guard` activity event and the
 *               change goes on.
 *  - `block` -> the same event, then a non-retryable TEST_INTEGRITY_GUARD failure. Like
 *               SECURITY_GATE_FAILURE it fails the step, and the run ends where it stands: a
 *               retry would re-run the whole paid session and the fixer would likely do it again.
 *               A diff that cannot be read, or was too large to read in full with nothing
 *               found in the part that was, fails as TEST_INTEGRITY_GUARD_UNAVAILABLE: a gate
 *               that cannot say the tests are intact does not say so.
 *
 * Heuristic by construction (see `@auto-swe/shared/lib/testIntegrity`): a clean result is not a
 * proof. Returns the findings (empty when clean or off).
 */
export async function runTestIntegrityGate(
  input: TestIntegrityGateInput
): Promise<TestIntegrityFinding[]> {
  const { mode, tracer } = input;
  if (mode === 'off') {
    return [];
  }
  let diff: string;
  try {
    diff = await input.readDiff();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracer.addActivityEvent({
      error: message,
      name: TEST_INTEGRITY_GUARD_EVENT,
      outputJson: { blocked: mode === 'block', degraded: true, mode },
    });
    if (mode === 'block') {
      throw ApplicationFailure.nonRetryable(
        `The test-integrity guard could not read the change, so it was not committed or pushed: ${message}`,
        'TEST_INTEGRITY_GUARD_UNAVAILABLE'
      );
    }
    return [];
  }
  const result = analyseTestIntegrity(diff);
  if (result.findings.length === 0) {
    if (result.truncatedDiff && mode === 'block') {
      throw ApplicationFailure.nonRetryable(
        'The change is too large for the test-integrity guard to read in full, so it was not ' +
          'committed or pushed.',
        'TEST_INTEGRITY_GUARD_UNAVAILABLE'
      );
    }
    return [];
  }
  const blocked = mode === 'block';
  tracer.addActivityEvent({
    name: TEST_INTEGRITY_GUARD_EVENT,
    outputJson: {
      blocked,
      count: result.findings.length,
      findings: result.findings,
      mode,
      truncatedDiff: result.truncatedDiff,
      truncatedFindings: result.truncatedFindings,
    },
  });
  if (blocked) {
    throw ApplicationFailure.nonRetryable(
      'The CI fix deletes, skips or weakens tests rather than fixing the code under test, so it ' +
        `was not committed or pushed:\n${summariseTestIntegrity(result.findings)}`,
      'TEST_INTEGRITY_GUARD',
      { findings: result.findings }
    );
  }
  return result.findings;
}
