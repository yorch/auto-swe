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
 * reference run hit an infrastructure error is left unscreened for the next
 * sweep rather than recorded as flaky.
 */

import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import type { FlakeScreenResult } from '@auto-swe/shared/types/workflow';
import type { EvalCaseRow } from './evalHarness.js';
import { runCaseReference } from './evalRevalidate.js';
import type { GateResult } from './qualityGates.js';
import { screenGateConsistency } from './standaloneGateRunner.js';

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
}

export async function screenDatasetCases(
  datasetId: string,
  deps: FlakeScreenDeps
): Promise<FlakeScreenResult> {
  const cases = await deps.loadCases(datasetId);
  const result: FlakeScreenResult = {
    erroredCaseIds: [],
    failedCaseIds: [],
    passed: 0,
    screened: 0,
  };
  for (const c of cases) {
    let consistent: boolean;
    try {
      ({ consistent } = await screenGateConsistency(deps.runs, () => deps.runReference(c)));
    } catch {
      result.erroredCaseIds.push(c.id);
      continue;
    }
    if (!(await deps.recordScreen(c, consistent, deps.runs))) {
      continue;
    }
    result.screened += 1;
    if (consistent) {
      result.passed += 1;
    } else {
      result.failedCaseIds.push(c.id);
    }
  }
  return result;
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
    loadCases: defaultLoadCases,
    recordScreen: defaultRecordScreen,
    runReference: runCaseReference,
    runs: await resolveSetting('evals.flakeScreenRuns', {}),
  });
}
