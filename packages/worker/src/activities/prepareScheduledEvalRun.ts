/**
 * Per-fire setup for the scheduled eval-regression workflow (evals P1).
 *
 * A Temporal Schedule has static args, so the scheduled workflow can't carry a
 * fresh `EvalRun` id per fire — it resolves the benchmark dataset by slug and
 * creates the run row here, on each fire, returning the input the harness needs.
 * Returns `null` when the configured dataset slug doesn't exist (e.g. the
 * benchmark hasn't been seeded yet) so the workflow can no-op instead of failing.
 */

import { prisma } from '@auto-swe/shared/db';
import type { ScheduledEvalInput } from '@auto-swe/shared/types/workflow';
import type { HarnessInput } from './evalHarness.js';

export async function prepareScheduledEvalRun(
  input: ScheduledEvalInput
): Promise<HarnessInput | null> {
  const dataset = await prisma.evalDataset.findFirst({
    select: { id: true },
    where: { slug: input.datasetSlug },
  });
  if (!dataset) {
    return null;
  }

  const run = await prisma.evalRun.create({
    data: {
      baselineRef: input.baselineRef,
      candidateRef: input.candidateRef,
      datasetId: dataset.id,
      status: 'RUNNING',
    },
    select: { id: true },
  });

  return {
    baselineRef: input.baselineRef,
    candidateRef: input.candidateRef,
    datasetId: dataset.id,
    evalRunId: run.id,
  };
}
