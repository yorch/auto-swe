/**
 * Offline eval harness — P1 of the evals feature (docs/evals-p1.md WS4).
 *
 * Orchestrates a candidate-vs-baseline comparison over a frozen benchmark:
 * for each case it obtains a binary floor outcome (golden test pass/fail) under
 * both arms, persists per-case `EvalResult` rows, and computes the paired,
 * error-barred regression verdict (evalStats). It writes the `EvalRun` summary
 * and marks the run SUCCESS / REGRESSION.
 *
 * The per-case execution (provision a fixture at its pinned SHA, run the
 * candidate/baseline implementer, run the golden test) is the expensive
 * Docker + LLM boundary — it is injected as `deps.runCase` so this orchestration
 * is deterministic and unit-testable. `runCaseDefault` wires the real path on
 * top of `runGateStandalone`.
 */

import { prisma } from '@auto-swe/shared/db';
import { recordEvalResult } from '../lib/evalCapture.js';
import { type PairedOutcome, regressionVerdict } from '../lib/evalStats.js';
import { runGateStandalone } from './standaloneGateRunner.js';

export interface EvalCaseRow {
  id: string;
  repoUrl: string;
  baselineSha: string;
  goldenTest: string;
  tags: string[];
}

export interface HarnessInput {
  evalRunId: string;
  datasetId: string;
  candidateRef: string;
  baselineRef: string;
}

export interface HarnessDeps {
  /** Resolve the dataset's cases. */
  loadCases: (datasetId: string) => Promise<EvalCaseRow[]>;
  /** Run one case under one arm; returns 1 (floor passed) or 0 (failed). */
  runCase: (caseRow: EvalCaseRow, ref: string) => Promise<0 | 1>;
  /** Persist one normalized signal (defaults to the real capture writer). */
  record?: typeof recordEvalResult;
  /** Finalize the EvalRun row. */
  finalize?: (evalRunId: string, status: string, summary: unknown) => Promise<void>;
}

async function defaultLoadCases(datasetId: string): Promise<EvalCaseRow[]> {
  return prisma.evalCase.findMany({
    select: { baselineSha: true, goldenTest: true, id: true, repoUrl: true, tags: true },
    where: { datasetId },
  });
}

async function defaultFinalize(evalRunId: string, status: string, summary: unknown): Promise<void> {
  await prisma.evalRun
    .update({
      data: { endedAt: new Date(), status, summary: summary as object },
      where: { id: evalRunId },
    })
    .catch(() => undefined);
}

/**
 * The real per-case runner: provision the fixture at its pinned SHA and run the
 * golden test as the execution floor. NOTE: generating the candidate's diff by
 * running the implementer for `ref` is the remaining integration seam — until
 * that is wired, this scores the fixture's current tree, which is sufficient to
 * exercise the floor + determinism. The agent-diff step is tracked in
 * docs/evals-p1.md WS4.
 */
export async function runCaseDefault(caseRow: EvalCaseRow, _ref: string): Promise<0 | 1> {
  const result = await runGateStandalone({
    authedRepoUrl: caseRow.repoUrl,
    branch: 'eval-candidate',
    checkoutSha: caseRow.baselineSha,
    command: caseRow.goldenTest,
    defaultBranch: 'main',
    gate: 'runTests',
  });
  return result.passed ? 1 : 0;
}

/**
 * Run the harness. Persists per-case rows + the run verdict; returns the
 * RegressionVerdict for the caller (CLI exit code / nightly gate).
 */
export async function runEvalHarness(input: HarnessInput, deps: HarnessDeps) {
  const record = deps.record ?? recordEvalResult;
  const finalize = deps.finalize ?? defaultFinalize;
  const cases = await deps.loadCases(input.datasetId);

  const pairs: PairedOutcome[] = [];
  for (const c of cases) {
    const [baseline, candidate] = await Promise.all([
      deps.runCase(c, input.baselineRef),
      deps.runCase(c, input.candidateRef),
    ]);
    pairs.push({ baseline, candidate, caseId: c.id, tags: c.tags });

    // Record the candidate's floor outcome as the gate signal for this run.
    await record({
      caseId: c.id,
      evalRunId: input.evalRunId,
      metadata: { tags: c.tags },
      passed: candidate === 1,
      scorer: 'gate:runTests',
      scoreType: 'BOOLEAN',
      source: 'GATE',
      value: candidate,
    });
  }

  const verdict = regressionVerdict(pairs);
  await finalize(input.evalRunId, verdict.regression ? 'REGRESSION' : 'SUCCESS', {
    byTag: verdict.byTag,
    overall: verdict.overall,
    summary: verdict.summary,
  });
  return verdict;
}

export const _defaults = { defaultFinalize, defaultLoadCases };

/**
 * Temporal activity entry: run the harness with the real DB + Docker deps. The
 * durable `EvalRunWorkflow` proxies this; the per-case execution (workspace at
 * the pinned SHA + golden test) happens here, not in the workflow isolate.
 */
export async function runEvalHarnessActivity(input: HarnessInput): Promise<void> {
  await runEvalHarness(input, {
    loadCases: defaultLoadCases,
    runCase: runCaseDefault,
  });
}
