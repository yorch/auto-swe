import {
  resolveConsolidationConfig,
  resolveEvalScheduleConfig,
  resolveRevalidationConfig,
  resolveScheduledSweeps,
} from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance } from 'fastify';

/**
 * Sync the system-wide Temporal Schedules with their configuration, once the
 * gateway's background Temporal connection is up (immediately on a healthy
 * start, later after an outage at boot). Each sync is best-effort: a failure is
 * logged. Consolidation, eval regression and revalidation can be re-saved from the
 * admin UI; the environment-driven schedules (repository dependency scan,
 * repository access sync, model discovery, run reaper, automation decision prune,
 * skill-source sync) are next synced at the following gateway start.
 *
 * Only these system schedules are re-synced here. Per-channel and
 * per-work-request schedules are reconciled when their own rows are written
 * (which is refused while Temporal is not connected), not at startup.
 */
export async function syncSchedulesOnceConnected(
  app: Pick<FastifyInstance, 'log' | 'temporal' | 'temporalConnection'>
): Promise<void> {
  await app.temporalConnection.whenConnected();
  const warn = (what: string) => (err: unknown) =>
    app.log.warn({ err }, `${what} schedule sync failed at startup`);

  resolveConsolidationConfig()
    .then((cfg) => app.temporal.syncConsolidationSchedule(cfg))
    .catch(warn('consolidation'));

  // Without this the repo-dependency schedule never exists, so the on-demand
  // "re-scan" trigger has no handle to fire.
  const sweeps = resolveScheduledSweeps();
  app.temporal
    .syncRepoDependencyScanSchedule(sweeps.repoDependency)
    .catch(warn('repo dependency scan'));
  // Paused unless an admin has enabled it: it spends GitHub quota proportional to
  // team members times repositories, so it must be a deliberate choice.
  app.temporal.syncRepoAccessSyncSchedule(sweeps.repoAccess).catch(warn('repo access sync'));
  // Model discovery only lists models, so it is on by default.
  app.temporal.syncModelDiscoverySchedule(sweeps.modelDiscovery).catch(warn('model discovery'));
  // The run reaper finalizes (and bills) runs whose workflow ended without
  // finalizing them. It only reads Temporal, so it is on by default.
  app.temporal.syncRunReaperSchedule(sweeps.runReaper).catch(warn('run reaper'));
  // Deletes automation decisions that started no run, past their retention. On by default.
  app.temporal
    .syncAutomationDecisionPruneSchedule(sweeps.automationDecisionPrune)
    .catch(warn('automation decision prune'));
  // One cheap request per tracked source; it only flags. On by default.
  app.temporal.syncSkillSourceSyncSchedule(sweeps.skillSourceSync).catch(warn('skill source sync'));
  // The nightly eval benchmark: off by default, needs a seeded dataset and a Docker-capable worker.
  resolveEvalScheduleConfig()
    .then((cfg) => app.temporal.syncEvalSchedule(cfg))
    .catch(warn('eval'));
  // The golden-set staleness check: off by default, same prerequisites.
  resolveRevalidationConfig()
    .then((cfg) => app.temporal.syncRevalidationSchedule(cfg))
    .catch(warn('revalidation'));
}
