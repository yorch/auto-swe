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
import { evalWorkspaceImageFor } from './evalWorkspaceImage.js';
import type { GateResult } from './qualityGates.js';
import { runGateStandalone } from './standaloneGateRunner.js';

export interface RevalCaseRow extends EvalCaseRow {
  quarantined: boolean;
}

export interface RevalidateDeps {
  loadCases: (datasetId: string) => Promise<RevalCaseRow[]>;
  /** Does the case's reference still pass against current repo state? */
  runReference: (c: RevalCaseRow) => Promise<GateResult>;
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
    const reference = await deps.runReference(c);
    // A killed or timed-out run says nothing about the case: leave it as it is.
    if (isInfrastructureFailure(reference)) {
      continue;
    }
    const passes = reference.passed;
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
      stack: true,
      tags: true,
    },
    where: { datasetId },
  });
}

/**
 * Run a case's reference once: its golden test at the pinned SHA, in the image
 * the harness scores the case in. Shared with flake screening
 * (`evalFlakeScreen.ts`), which runs it k times. Throws on an infrastructure
 * error (clone, workspace), like `runGateStandalone`.
 */
export function runCaseReference(c: EvalCaseRow): Promise<GateResult> {
  return runGateStandalone({
    authedRepoUrl: c.repoUrl,
    branch: 'eval-reval',
    checkoutSha: c.baselineSha,
    command: c.goldenTest,
    defaultBranch: 'main',
    gate: 'runTests',
    image: evalWorkspaceImageFor(c.stack),
    teamId: c.teamId,
  });
}

/**
 * A reference run that says nothing about the test: killed by a signal or a
 * timeout. `signal` is set when the runner killed the command (its timeout,
 * exit 124) or could not start it; an exit of 128 to 254 is a process
 * killed inside the container — 137 is SIGKILL, typically the out-of-memory
 * killer, 143 SIGTERM. Exit 255 is what a test's own `exit(-1)` produces, so it
 * is a test failure. Such a case is left unscreened for the next screen rather
 * than marked flaky, until `FLAKE_SCREEN_MAX_INFRA_ERRORS` screens in a row have
 * failed this way.
 *
 * Every other non-zero exit is a test failure. The runner sees only the golden
 * test's exit status, so a dependency install or network fetch inside the
 * test command that fails (exit 1) is indistinguishable from a failing test and
 * marks the case flaky; an admin re-screen clears it. A test suite that itself
 * dies on a signal is the reverse: it is retried until the error cap records it
 * as a failed screen, which an admin re-screen resets.
 */
export function isInfrastructureFailure(r: GateResult): boolean {
  return r.signal !== undefined || (r.exitCode >= 128 && r.exitCode < 255);
}

function runReferenceDefault(c: RevalCaseRow): Promise<GateResult> {
  return runCaseReference(c);
}

async function defaultSetQuarantined(caseId: string, quarantined: boolean): Promise<void> {
  // A restored case passes again in a different repo state than its last flake
  // screen saw, so that screen says nothing now: it goes back to unscreened, and
  // the harness scores it only once a new screen (the sweep's, right after this)
  // passes.
  const data = quarantined
    ? { quarantined }
    : { flakeRuns: 0, flakeScreened: false, flakeScreenInfraErrors: 0, quarantined };
  await prisma.evalCase.update({ data, where: { id: caseId } }).catch(() => undefined);
}

export const _defaults = { defaultSetQuarantined };

/** Activity entry: re-validate a dataset with the real DB + Docker deps. */
export async function revalidateDatasetActivity(datasetId: string): Promise<RevalidateResult> {
  return revalidateDataset(datasetId, {
    loadCases: defaultLoadCases,
    runReference: runReferenceDefault,
    setQuarantined: defaultSetQuarantined,
  });
}
