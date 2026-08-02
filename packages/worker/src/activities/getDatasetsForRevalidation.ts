import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { ScheduledRevalidationInput } from '@auto-swe/shared/types/workflow';

export interface DatasetForRevalidation {
  datasetId: string;
}

/** Returns all datasets (optionally filtered by slug substring) for re-validation. */
export async function getDatasetsForRevalidation(
  input?: ScheduledRevalidationInput
): Promise<DatasetForRevalidation[]> {
  const datasets = await runUnscoped(
    'scheduled re-validation sweeps all datasets: the schedule is deployment-wide, not per-team',
    ['EvalDataset'],
    () =>
      prisma.evalDataset.findMany({
        select: { id: true },
        where: input?.datasetSlug ? { slug: { contains: input.datasetSlug } } : undefined,
      })
  );
  return datasets.map((d) => ({ datasetId: d.id }));
}
