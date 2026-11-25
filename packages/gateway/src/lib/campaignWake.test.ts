import { describe, expect, it } from 'vitest';
import { signalCampaignReconciler } from './campaignWake.js';

const campaign = (extra = {}) => ({
  id: 'c1',
  ownerTeamId: 'team-1',
  temporalWorkflowId: 'campaign-c1',
  workflowKind: 'RECONCILER',
  ...extra,
});

function world(row: { state: string; workflowKind: string } | null) {
  const sent: Array<{ id: string; name: string; payload: unknown; start: unknown }> = [];
  const reads: unknown[] = [];
  const fastify = {
    prisma: {
      campaign: {
        findFirst: async (args: unknown) => {
          reads.push(args);
          return row;
        },
      },
    },
    temporal: {
      signalCampaignWorkflow: async (
        id: string,
        name: string,
        payload: unknown,
        start?: unknown
      ) => {
        sent.push({ id, name, payload, start });
        return 'signalled';
      },
    },
  };
  return { fastify: fastify as never, reads, sent };
}

const START = { campaignId: 'c1', campaignWorkflowId: 'campaign-c1' };

describe('signalCampaignReconciler', () => {
  it.each(['PLANNING', 'STARTING', 'ACTIVE', 'PAUSED', 'MONITORING'])(
    'starts the reconciler under the same id when the campaign is %s',
    async (state) => {
      const w = world({ state, workflowKind: 'RECONCILER' });
      await expect(
        signalCampaignReconciler(w.fastify, campaign(), 'campaignControl', { action: 'pause' })
      ).resolves.toBe('signalled');
      expect(w.sent).toEqual([
        { id: 'campaign-c1', name: 'campaignControl', payload: { action: 'pause' }, start: START },
      ]);
    }
  );

  it.each(['COMPLETED', 'COMPLETED_WITH_FAILURES', 'CANCELLED', 'FAILED_TO_START', 'CANCELLING'])(
    'signals but never starts when the campaign row says %s',
    async (state) => {
      const w = world({ state, workflowKind: 'RECONCILER' });
      await signalCampaignReconciler(w.fastify, campaign(), 'campaignControl', {});
      expect(w.sent).toHaveLength(1);
      expect(w.sent[0]?.start).toBeUndefined();
    }
  );

  it('decides by the row as it is now, not by the caller’s earlier read', async () => {
    const w = world({ state: 'COMPLETED', workflowKind: 'RECONCILER' });
    await signalCampaignReconciler(w.fastify, campaign({ state: 'ACTIVE' } as never), 'x', {});
    expect(w.sent[0]?.start).toBeUndefined();
    expect(w.reads).toEqual([
      { select: { state: true, workflowKind: true }, where: { id: 'c1', ownerTeamId: 'team-1' } },
    ]);
  });

  it('never starts for a legacy campaign, whatever the caller or the row says, and sends nothing', async () => {
    const legacyCaller = world({ state: 'ACTIVE', workflowKind: 'RECONCILER' });
    await expect(
      signalCampaignReconciler(legacyCaller.fastify, campaign({ workflowKind: 'LEGACY' }), 'x', {})
    ).resolves.toBe('not-running');
    expect(legacyCaller.sent).toEqual([]);
    const legacyRow = world({ state: 'ACTIVE', workflowKind: 'LEGACY' });
    await signalCampaignReconciler(legacyRow.fastify, campaign(), 'x', {});
    expect(legacyRow.sent[0]?.start).toBeUndefined();
  });

  it('does not start for a campaign whose row is gone', async () => {
    const w = world(null);
    await signalCampaignReconciler(w.fastify, campaign(), 'x', {});
    expect(w.sent[0]?.start).toBeUndefined();
  });

  it('lets a failed delivery propagate for the caller to treat as a delay', async () => {
    const w = world({ state: 'ACTIVE', workflowKind: 'RECONCILER' });
    (w.fastify as unknown as { temporal: { signalCampaignWorkflow: () => never } }).temporal = {
      signalCampaignWorkflow: () => {
        throw new Error('unreachable');
      },
    };
    await expect(signalCampaignReconciler(w.fastify, campaign(), 'x', {})).rejects.toThrow(
      'unreachable'
    );
  });
});
