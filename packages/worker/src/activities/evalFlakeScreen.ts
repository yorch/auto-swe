/**
 * Flake screening of benchmark cases (docs/evals.md §4).
 *
 * A case's reference — its golden test at the pinned SHA — is run k times
 * (`evals.flakeScreenRuns`). The case is marked `flakeScreened` only when every
 * run passed; otherwise it is recorded as a failed screen. Either way
 * `flakeRuns` becomes k, so `flakeRuns = 0` is what marks a case that was never
 * screened. The harness scores only screened cases (`defaultLoadCases` in
 * `evalHarness.ts`), so a flaky floor cannot move the regression verdict.
 *
 * Only never-screened, non-quarantined cases are screened: a quarantined case's
 * reference is known not to pass, and the harness skips it anyway. A case whose
 * reference run hit an infrastructure error — the workspace could not be
 * provisioned, or the run was killed or timed out (`isInfrastructureFailure`)
 * — is left unscreened for the next screen rather than recorded as flaky.
 */

import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import type { FlakeScreenResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import type { EvalCaseRow } from './evalHarness.js';
import { runCaseReference } from './evalRevalidate.js';
import type { GateResult } from './qualityGates.js';

export interface FlakeScreenDeps {
  /** k: how many times each reference runs. */
  runs: number;
  /** The dataset's never-screened, non-quarantined cases. */
  loadCases: (datasetId: string) => Promise<EvalCaseRow[]>;
  /** Run the case's reference once. Throws on an infrastructure error. */
  runReference: (c: EvalCaseRow) => Promise<GateResult>;
  /**
   * Record the screen's outcome. Resolves false when the case was not written:
   * its reference changed, or another screen recorded it, while this one ran.
   */
  recordScreen: (c: EvalCaseRow, flakeScreened: boolean, runs: number) => Promise<boolean>;
  /** Report progress after each reference run (the activity's heartbeat). */
  heartbeat?: (details: { caseId: string; run: number }) => void;
}

/**
 * Loads per screen: the first, plus reloads for cases that arrived while it
 * ran. A bound, so a dataset reset over and over cannot hold one activity.
 */
const MAX_SCREEN_PASSES = 5;

export async function screenDatasetCases(
  datasetId: string,
  deps: FlakeScreenDeps
): Promise<FlakeScreenResult> {
  const result: FlakeScreenResult = {
    erroredCaseIds: [],
    failedCaseIds: [],
    passed: 0,
    screened: 0,
  };
  // Reloaded until nothing is left: a start that joined this screen while it ran
  // (cases added, or reset for a re-screen) relies on it to pick them up. A
  // recorded case is no longer loaded; one left unrecorded (an infrastructure
  // error, a concurrent change) is not retried by this screen, so it cannot loop.
  const skip = new Set<string>();
  for (let pass = 0; pass < MAX_SCREEN_PASSES; pass += 1) {
    const cases = (await deps.loadCases(datasetId)).filter((c) => !skip.has(c.id));
    if (cases.length === 0) {
      break;
    }
    for (const c of cases) {
      if (!(await screenOne(c, deps, result))) {
        skip.add(c.id);
      }
    }
  }
  return result;
}

/**
 * A reference run that says nothing about the test: killed by a signal or a
 * timeout. `signal` is set when the runner killed the command (its timeout,
 * exit 124) or could not start it; an exit of 128 and above is a process
 * killed inside the container — 137 is SIGKILL, typically the out-of-memory
 * killer, 143 SIGTERM. Such a case is left unscreened for the next screen
 * rather than marked flaky.
 *
 * Every other non-zero exit is a test failure. The runner sees only the golden
 * test's exit status, so a dependency install or network fetch inside the
 * test command that fails (exit 1) is indistinguishable from a failing test and
 * marks the case flaky; an admin re-screen clears it. A test suite that itself
 * dies on a signal is the reverse: it never screens, and is retried each time.
 */
export function isInfrastructureFailure(r: GateResult): boolean {
  return r.signal !== undefined || r.exitCode >= 128;
}

/** Screen one case; resolves whether its outcome was recorded. */
async function screenOne(
  c: EvalCaseRow,
  deps: FlakeScreenDeps,
  result: FlakeScreenResult
): Promise<boolean> {
  // Consistent only when every one of the k runs passed, so the first failure
  // decides the case and the remaining runs are not paid for.
  let consistent = deps.runs > 0;
  try {
    for (let run = 1; run <= deps.runs; run += 1) {
      const r = await deps.runReference(c);
      // Per run: one reference run (a clone plus the golden test) can take
      // minutes, and the activity's heartbeat timeout is shorter than a case.
      deps.heartbeat?.({ caseId: c.id, run });
      if (isInfrastructureFailure(r)) {
        result.erroredCaseIds.push(c.id);
        return false;
      }
      if (!r.passed) {
        consistent = false;
        break;
      }
    }
  } catch {
    result.erroredCaseIds.push(c.id);
    return false;
  }
  if (!(await deps.recordScreen(c, consistent, deps.runs))) {
    return false;
  }
  result.screened += 1;
  if (consistent) {
    result.passed += 1;
  } else {
    result.failedCaseIds.push(c.id);
  }
  return true;
}

async function defaultLoadCases(datasetId: string): Promise<EvalCaseRow[]> {
  return prisma.evalCase.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      baselineSha: true,
      goldenTest: true,
      id: true,
      input: true,
      repoUrl: true,
      tags: true,
    },
    where: { datasetId, flakeRuns: 0, quarantined: false },
  });
}

async function defaultRecordScreen(
  c: EvalCaseRow,
  flakeScreened: boolean,
  runs: number
): Promise<boolean> {
  // Conditional on the reference this screen ran and on the case still being
  // unscreened, so a result never lands on a reference it did not run.
  const { count } = await prisma.evalCase.updateMany({
    data: { flakeRuns: runs, flakeScreened },
    where: {
      baselineSha: c.baselineSha,
      flakeRuns: 0,
      goldenTest: c.goldenTest,
      id: c.id,
      repoUrl: c.repoUrl,
    },
  });
  return count > 0;
}

/**
 * Activity entry: screen a dataset's never-screened cases with the real DB +
 * Docker deps. Idempotent across retries — a recorded case is no longer loaded.
 */
export async function screenDatasetCasesActivity(datasetId: string): Promise<FlakeScreenResult> {
  return screenDatasetCases(datasetId, {
    heartbeat: (details) => heartbeat(details),
    loadCases: defaultLoadCases,
    recordScreen: defaultRecordScreen,
    runReference: runCaseReference,
    runs: await resolveSetting('evals.flakeScreenRuns', {}),
  });
}
