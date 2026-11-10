import { resolveSetting } from '@auto-swe/shared/config';
import {
  analyseNameStatus,
  analyseTestIntegrity,
  summariseTestIntegrity,
  TEST_INTEGRITY_GUARD_EVENT,
  type TestIntegrityFinding,
} from '@auto-swe/shared/lib/testIntegrity';
import { ApplicationFailure } from '@temporalio/activity';
import type { AgentTracer } from './agentTracer.js';

export type TestIntegrityGuardMode = 'off' | 'warn' | 'block';

export const TEST_INTEGRITY_SETTING = 'github.ciFixTestIntegrityGuard';

/**
 * The guard mode for a session, resolved from the setting registry. Call it BEFORE the paid
 * agent session: a lookup that throws afterwards would fail the activity retryably and re-run the
 * whole session. A value that is not one of the three modes (it cannot be stored, but a degraded
 * read could return the default) is the default, `warn`, never `off`.
 */
export async function resolveTestIntegrityMode(
  ctx: Parameters<typeof resolveSetting>[1]
): Promise<TestIntegrityGuardMode> {
  const configured = await resolveSetting(TEST_INTEGRITY_SETTING, ctx);
  return configured === 'off' || configured === 'block' ? configured : 'warn';
}

export interface TestIntegrityGateInput {
  mode: TestIntegrityGuardMode;
  /**
   * The change the fixer made, as a unified diff of the COMMITTED result, read after the commit and
   * before the push (see `commitWithTestIntegrity`).
   */
  readDiff: () => Promise<string>;
  /**
   * `git diff --name-status` of the same change, read only when the diff was too large to analyse
   * in full, so deleted test files are still seen. Best effort: a failure is ignored.
   */
  readNameStatus?: () => Promise<string>;
  tracer: AgentTracer;
}

/**
 * The test-integrity gate of a fix session: did the fixer reach green by deleting, skipping or
 * weakening tests? Runs on the committed result after the agent and before the push, so a block
 * leaves nothing pushable and what is pushed is what was analysed.
 *
 *  - `off`   -> not read, nothing recorded.
 *  - `warn`  -> a trip is recorded as a `ci_fix.test_integrity_guard` activity event and the
 *               change goes on.
 *  - `block` -> the same event, then a non-retryable TEST_INTEGRITY_GUARD failure when any
 *               HIGH-severity finding exists (low-severity findings, such as a deleted fixture or
 *               a regenerated snapshot, are recorded but never block). The step fails; where the
 *               run goes next is the template's failure route (the typed error's message, with the
 *               findings, is recorded on the step), because a retry would re-run the whole paid
 *               session and the fixer would likely do it again. A diff that cannot be read, or
 *               was too large to read in full with nothing found in the part that was, fails as
 *               TEST_INTEGRITY_GUARD_UNAVAILABLE: a gate that cannot say the tests are intact
 *               does not say so.
 *
 * A diff longer than the analysis cap always records a `degraded` event (it is not a trip) so the
 * report shows how often the guard read less than the whole change.
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
        `The test-integrity guard could not read the change, so it was not pushed: ${message}`,
        'TEST_INTEGRITY_GUARD_UNAVAILABLE'
      );
    }
    return [];
  }
  const result = analyseTestIntegrity(diff);
  let findings = result.findings;
  if (result.truncatedDiff) {
    try {
      const names = analyseNameStatus((await input.readNameStatus?.()) ?? '');
      findings = [...names, ...findings];
    } catch {
      // Best effort: the head of the diff was analysed.
    }
    tracer.addActivityEvent({
      name: TEST_INTEGRITY_GUARD_EVENT,
      outputJson: {
        blocked: false,
        degraded: true,
        mode,
        reason: 'diff longer than the analysis cap; only its head and the file list were read',
        truncatedDiff: true,
      },
    });
  }
  const blocking = findings.filter((f) => f.severity === 'high');
  const unreadable = result.truncatedDiff && blocking.length === 0;
  const blocked = mode === 'block' && (blocking.length > 0 || unreadable);
  if (findings.length > 0) {
    tracer.addActivityEvent({
      name: TEST_INTEGRITY_GUARD_EVENT,
      outputJson: {
        blocked,
        count: findings.length,
        findings,
        highCount: blocking.length,
        mode,
        truncatedDiff: result.truncatedDiff,
        truncatedFindings: result.truncatedFindings,
      },
    });
  }
  if (blocked && blocking.length === 0) {
    throw ApplicationFailure.nonRetryable(
      'The change is too large for the test-integrity guard to read in full, so it was not pushed.',
      'TEST_INTEGRITY_GUARD_UNAVAILABLE'
    );
  }
  if (blocked) {
    throw ApplicationFailure.nonRetryable(
      'The fix deletes, skips or weakens tests rather than fixing the code under test, so it ' +
        `was not pushed:\n${summariseTestIntegrity(findings)}`,
      'TEST_INTEGRITY_GUARD',
      { findings }
    );
  }
  return findings;
}
