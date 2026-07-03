/**
 * Golden-set re-validation loop — P3 of the evals feature (docs/evals-p3.md WS6,
 * RFC §9 dataset-rot fix).
 *
 * A scheduled job re-runs each `EvalCase`'s reference (its golden test at the
 * pinned SHA) against current repo state. When the reference no longer passes,
 * the case has gone *stale* (not the agent's fault) and is quarantined so it
 * drops out of the gate (`defaultLoadCases` filters `quarantined: false`). When
 * a previously-quarantined case passes again, it is restored.
 *
 * The per-case execution is injected (`runReference`) so the loop is
 * deterministic + unit-testable; `runReferenceDefault` wires the real path over
 * `runGateStandalone` at the pinned SHA.
 */

import { prisma } from '@auto-swe/shared/db';
import type { EvalCaseRow } from './evalHarness.js';
import { runGateStandalone } from './standaloneGateRunner.js';

export interface RevalCaseRow extends EvalCaseRow {
  quarantined: boolean;
}

export interface RevalidateDeps {
  loadCases: (datasetId: string) => Promise<RevalCaseRow[]>;
  /** Does the case's reference still pass against current repo state? */
  runReference: (c: RevalCaseRow) => Promise<boolean>;
  setQuarantined: (caseId: string, quarantined: boolean) => Promise<void>;
}

export interface RevalidateResult {
  checked: number;
  /** Newly quarantined this run (were passing, now stale). */
  quarantined: number;
  /** Restored this run (were quarantined, now pass again). */
  restored: number;
}

export async function revalidateDataset(
  datasetId: string,
  deps: RevalidateDeps
): Promise<RevalidateResult> {
  const cases = await deps.loadCases(datasetId);
  let quarantined = 0;
  let restored = 0;
  for (const c of cases) {
    const passes = await deps.runReference(c);
    if (!passes && !c.quarantined) {
      await deps.setQuarantined(c.id, true);
      quarantined += 1;
    } else if (passes && c.quarantined) {
      await deps.setQuarantined(c.id, false);
      restored += 1;
    }
  }
  return { checked: cases.length, quarantined, restored };
}

async function defaultLoadCases(datasetId: string): Promise<RevalCaseRow[]> {
  return prisma.evalCase.findMany({
    select: {
      baselineSha: true,
      goldenTest: true,
      id: true,
      input: true,
      quarantined: true,
      repoUrl: true,
      tags: true,
    },
    where: { datasetId },
  });
}

async function runReferenceDefault(c: RevalCaseRow): Promise<boolean> {
  const r = await runGateStandalone({
    authedRepoUrl: c.repoUrl,
    branch: 'eval-reval',
    checkoutSha: c.baselineSha,
    command: c.goldenTest,
    defaultBranch: 'main',
    gate: 'runTests',
  });
  return r.passed;
}

async function defaultSetQuarantined(caseId: string, quarantined: boolean): Promise<void> {
  await prisma.evalCase
    .update({ data: { quarantined }, where: { id: caseId } })
    .catch(() => undefined);
}

/** Activity entry: re-validate a dataset with the real DB + Docker deps. */
export async function revalidateDatasetActivity(datasetId: string): Promise<RevalidateResult> {
  return revalidateDataset(datasetId, {
    loadCases: defaultLoadCases,
    runReference: runReferenceDefault,
    setQuarantined: defaultSetQuarantined,
  });
}
