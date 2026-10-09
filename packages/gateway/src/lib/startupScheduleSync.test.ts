import { describe, expect, it, vi } from 'vitest';

const cfg = { enabled: false };
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveConsolidationConfig: async () => cfg,
  resolveEvalScheduleConfig: async () => cfg,
  resolveRevalidationConfig: async () => cfg,
  resolveScheduledSweeps: () => ({
    automationDecisionPrune: cfg,
    modelDiscovery: cfg,
    repoAccess: cfg,
    repoDependency: cfg,
    runReaper: cfg,
    skillSourceSync: cfg,
  }),
}));

import { syncSchedulesOnceConnected } from './startupScheduleSync.js';

const SYNCS = [
  'syncConsolidationSchedule',
  'syncRepoDependencyScanSchedule',
  'syncRepoAccessSyncSchedule',
  'syncModelDiscoverySchedule',
  'syncRunReaperSchedule',
  'syncAutomationDecisionPruneSchedule',
  'syncSkillSourceSyncSchedule',
  'syncEvalSchedule',
  'syncRevalidationSchedule',
] as const;

function fakeApp() {
  let connect: () => void = () => undefined;
  const connected = new Promise<void>((r) => {
    connect = r;
  });
  const temporal = Object.fromEntries(SYNCS.map((n) => [n, vi.fn(async () => undefined)]));
  const log = { warn: vi.fn() };
  const app = {
    log,
    temporal,
    temporalConnection: { state: () => 'connecting', whenConnected: () => connected },
  };
  return { app: app as never, connect, log, temporal };
}

describe('syncSchedulesOnceConnected', () => {
  it('syncs nothing before Temporal connects, then every system schedule', async () => {
    const { app, connect, temporal } = fakeApp();
    const done = syncSchedulesOnceConnected(app);
    await new Promise((r) => setTimeout(r, 20));
    for (const n of SYNCS) {
      expect(temporal[n]).not.toHaveBeenCalled();
    }
    connect();
    await done;
    await new Promise((r) => setTimeout(r, 20));
    for (const n of SYNCS) {
      expect(temporal[n]).toHaveBeenCalledOnce();
    }
  });

  it('logs and carries on when one sync fails', async () => {
    const { app, connect, temporal, log } = fakeApp();
    temporal.syncRunReaperSchedule.mockRejectedValue(new Error('boom'));
    connect();
    await syncSchedulesOnceConnected(app);
    await new Promise((r) => setTimeout(r, 20));
    expect(log.warn).toHaveBeenCalledOnce();
    expect(temporal.syncEvalSchedule).toHaveBeenCalledOnce();
  });
});
