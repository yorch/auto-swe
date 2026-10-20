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
 * — is left unscreened for the next screen rather than recorded as flaky. Each
 * such error is counted on the case (`flakeScreenInfraErrors`); at
 * `FLAKE_SCREEN_MAX_INFRA_ERRORS` the case is recorded as a failed screen, so a
 * test that always dies on a signal does not loop through every screen forever.
 */

import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import {
  FLAKE_SCREEN_MAX_INFRA_ERRORS,
  type FlakeScreenResult,
} from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import type { EvalCaseRow } from './evalHarness.js';
import { isInfrastructureFailure, runCaseReference } from './evalRevalidate.js';
import type { GateResult } from './qualityGates.js';

/** Infrastructure errors after which a case is recorded as a failed screen. */
export { FLAKE_SCREEN_MAX_INFRA_ERRORS };

/** A case to screen, with the infrastructure errors earlier screens counted on it. */
export interface ScreenCaseRow extends EvalCaseRow {
  infraErrors: number;
}

// Defined beside the reference runner both loops share; re-exported for callers of the screen.
export { isInfrastructureFailure };

export interface FlakeScreenDeps {
  /** k: how many times each reference runs. */
  runs: number;
  /** The dataset's never-screened, non-quarantined cases. */
  loadCases: (datasetId: string) => Promise<ScreenCaseRow[]>;
  /** Run the case's reference once. Throws on an infrastructure error. */
  runReference: (c: ScreenCaseRow) => Promise<GateResult>;
  /**
   * Record the screen's outcome. Resolves false when the case was not written:
   * its reference changed, or another screen recorded it, while this one ran.
   */
  recordScreen: (c: ScreenCaseRow, flakeScreened: boolean, runs: number) => Promise<boolean>;
  /**
   * Count an infrastructure error on the case. At the cap
   * (`FLAKE_SCREEN_MAX_INFRA_ERRORS`) it also records the case as a failed
   * screen. Resolves true only when that failed screen was recorded.
   */
  recordInfraError: (c: ScreenCaseRow, runs: number) => Promise<boolean>;
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
  deps: FlakeScreenDeps,
  skipCaseIds: readonly string[] = []
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
  const skip = new Set<string>(skipCaseIds);
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

/** Screen one case; resolves whether its outcome was recorded. */
async function screenOne(
  c: ScreenCaseRow,
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
        return recordInfraFailure(c, deps, result);
      }
      if (!r.passed) {
        consistent = false;
        break;
      }
    }
  } catch {
    return recordInfraFailure(c, deps, result);
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

/**
 * Count an infrastructure failure on the case. Resolves whether it reached the
 * cap and was recorded as a failed screen; otherwise the case stays unscreened.
 * A failure to count is not allowed to abort the screen of the other cases.
 */
async function recordInfraFailure(
  c: ScreenCaseRow,
  deps: FlakeScreenDeps,
  result: FlakeScreenResult
): Promise<boolean> {
  let capped = false;
  try {
    capped = await deps.recordInfraError(c, deps.runs);
  } catch {
    capped = false;
  }
  if (!capped) {
    result.erroredCaseIds.push(c.id);
    return false;
  }
  result.screened += 1;
  result.failedCaseIds.push(c.id);
  return true;
}

async function defaultCountUnscreened(
  datasetId: string,
  skipCaseIds: readonly string[]
): Promise<number> {
  return prisma.evalCase.count({
    where: {
      datasetId,
      flakeRuns: 0,
      flakeScreenInfraErrors: { lt: FLAKE_SCREEN_MAX_INFRA_ERRORS },
      id: { notIn: [...skipCaseIds] },
      quarantined: false,
    },
  });
}

async function defaultLoadCases(datasetId: string): Promise<ScreenCaseRow[]> {
  const rows = await prisma.evalCase.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      baselineSha: true,
      dataset: { select: { teamId: true } },
      flakeScreenInfraErrors: true,
      goldenTest: true,
      id: true,
      input: true,
      repoUrl: true,
      tags: true,
    },
    where: {
      datasetId,
      flakeRuns: 0,
      flakeScreenInfraErrors: { lt: FLAKE_SCREEN_MAX_INFRA_ERRORS },
      quarantined: false,
    },
  });
  return rows.map(({ dataset, flakeScreenInfraErrors, ...rest }) => ({
    ...rest,
    infraErrors: flakeScreenInfraErrors,
    teamId: dataset?.teamId ?? null,
  }));
}

async function defaultRecordInfraError(c: ScreenCaseRow, runs: number): Promise<boolean> {
  // Same guard as recordScreen: only the reference this screen ran, still unscreened.
  const where = {
    baselineSha: c.baselineSha,
    flakeRuns: 0,
    goldenTest: c.goldenTest,
    id: c.id,
    repoUrl: c.repoUrl,
  };
  await prisma.evalCase.updateMany({
    data: { flakeScreenInfraErrors: { increment: 1 } },
    where,
  });
  // The cap is decided by the stored counter, not the value this screen loaded:
  // a concurrent screen may have counted too, and an admin reset may have
  // zeroed it since. Only the write that lands records the failed screen.
  const { count } = await prisma.evalCase.updateMany({
    data: { flakeRuns: runs, flakeScreened: false },
    where: { ...where, flakeScreenInfraErrors: { gte: FLAKE_SCREEN_MAX_INFRA_ERRORS } },
  });
  return count > 0;
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
export async function screenDatasetCasesActivity(
  datasetId: string,
  skipCaseIds: readonly string[] = []
): Promise<FlakeScreenResult> {
  return screenDatasetCases(
    datasetId,
    {
      heartbeat: (details) => heartbeat(details),
      loadCases: defaultLoadCases,
      recordInfraError: defaultRecordInfraError,
      recordScreen: defaultRecordScreen,
      runReference: runCaseReference,
      runs: await resolveSetting('evals.flakeScreenRuns', {}),
    },
    skipCaseIds
  );
}

/**
 * Activity entry: how many cases a screen would still pick up — never screened,
 * not quarantined, under the infrastructure-error cap — leaving out `skipCaseIds`.
 * The screen workflow asks it after each screen, to catch cases that arrived once
 * the activity's last load was done.
 */
export async function countUnscreenedCasesActivity(
  datasetId: string,
  skipCaseIds: readonly string[] = []
): Promise<number> {
  return defaultCountUnscreened(datasetId, skipCaseIds);
}
