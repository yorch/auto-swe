import { describe, expect, it, vi } from 'vitest';
import { notifyCampaignsOfPullRequest } from './campaignSignals.js';

interface Attempt {
  childWorkflowId?: string;
  id: string;
  n: number;
  runId: string | null;
  targetId: string;
  campaign: {
    id: string;
    ownerTeamId: string;
    state: string;
    temporalWorkflowId: string;
    workflowKind: string;
  };
}

function world(
  attempts: Attempt[],
  opts: { signalFails?: Error; lookupFails?: boolean; freshState?: string } = {}
) {
  const signals: Array<{ id: string; name: string; payload: unknown; start?: unknown }> = [];
  const backfilled: Array<{ id: string; runId: string }> = [];
  const warn = vi.fn();
  const fastify = {
    log: { warn },
    prisma: {
      campaign: {
        // The row as it is when the signal goes out, which may differ from the one the lookup saw.
        findFirst: async (args: { where: { id: string } }) => {
          const row = attempts.find((a) => a.campaign.id === args.where.id)?.campaign;
          return row
            ? { state: opts.freshState ?? row.state, workflowKind: row.workflowKind }
            : null;
        },
      },
      campaignAttempt: {
        findFirst: async (args: { where: { n: { gt: number }; targetId: string } }) =>
          attempts.find((a) => a.targetId === args.where.targetId && a.n > args.where.n.gt) ?? null,
        findMany: async (args: {
          where: { OR: Array<{ runId?: string; childWorkflowId?: string }> };
        }) => {
          if (opts.lookupFails) {
            throw new Error('db down');
          }
          return attempts
            .filter((a) =>
              args.where.OR.some(
                (m) =>
                  (m.runId !== undefined && a.runId === m.runId) ||
                  (m.childWorkflowId !== undefined && a.childWorkflowId === m.childWorkflowId)
              )
            )
            .map((a) => ({ ...a, target: { campaign: a.campaign, id: a.targetId } }));
        },
        updateMany: async (args: { data: { runId: string }; where: { id: string } }) => {
          backfilled.push({ id: args.where.id, runId: args.data.runId });
          return { count: 1 };
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
        if (opts.signalFails) {
          throw opts.signalFails;
        }
        signals.push({ id, name, payload, ...(start ? { start } : {}) });
        return 'signalled';
      },
    },
  };
  return { backfilled, fastify: fastify as never, signals, warn };
}

const campaign = (extra = {}) => ({
  id: 'c1',
  ownerTeamId: 'team-1',
  state: 'ACTIVE',
  temporalWorkflowId: 'campaign-c1',
  workflowKind: 'RECONCILER',
  ...extra,
});

describe('notifyCampaignsOfPullRequest', () => {
  it('signals the campaign whose target’s latest attempt opened the pull request', async () => {
    const w = world([{ campaign: campaign(), id: 'a1', n: 1, runId: 'run-1', targetId: 't1' }]);
    await notifyCampaignsOfPullRequest(w.fastify, {
      runId: 'run-1',
      status: 'MERGED',
      workflowId: 'campaign-c1-r',
    });
    expect(w.signals).toEqual([
      {
        id: 'campaign-c1',
        name: 'campaignPullRequestChanged',
        payload: { runId: 'run-1', status: 'MERGED', targetId: 't1' },
        // A reconciler that has died is started again from the rows, under the same id.
        start: { campaignId: 'c1', campaignWorkflowId: 'campaign-c1' },
      },
    ]);
  });

  it('does not ask for a restart when the campaign finished or began cancelling since the lookup', async () => {
    for (const freshState of ['COMPLETED', 'CANCELLED', 'FAILED_TO_START', 'CANCELLING']) {
      const w = world([{ campaign: campaign(), id: 'a1', n: 1, runId: 'run-1', targetId: 't1' }], {
        freshState,
      });
      await notifyCampaignsOfPullRequest(w.fastify, {
        runId: 'run-1',
        status: 'MERGED',
        workflowId: null,
      });
      // The signal still goes (a live reconciler wants it); only the start is withheld.
      expect(w.signals).toHaveLength(1);
      expect(w.signals[0]).not.toHaveProperty('start');
    }
  });

  it('ignores an earlier attempt, a legacy campaign and a campaign that has finished', async () => {
    const w = world([
      { campaign: campaign(), id: 'a1', n: 1, runId: 'run-1', targetId: 't1' },
      { campaign: campaign(), id: 'a2', n: 2, runId: 'run-2', targetId: 't1' },
      {
        campaign: campaign({ workflowKind: 'LEGACY' }),
        id: 'a3',
        n: 1,
        runId: 'run-1',
        targetId: 't2',
      },
      {
        campaign: campaign({ state: 'COMPLETED' }),
        id: 'a4',
        n: 1,
        runId: 'run-1',
        targetId: 't3',
      },
    ]);
    await notifyCampaignsOfPullRequest(w.fastify, {
      runId: 'run-1',
      status: 'CLOSED',
      workflowId: null,
    });
    expect(w.signals).toEqual([]);
  });

  it('finds an attempt through its workflow id and writes the run id it lacked', async () => {
    const w = world([
      {
        campaign: campaign(),
        childWorkflowId: 'campaign-c1-repo',
        id: 'a1',
        n: 1,
        runId: null,
        targetId: 't1',
      },
    ]);
    await notifyCampaignsOfPullRequest(w.fastify, {
      runId: 'run-9',
      status: 'OPEN',
      workflowId: 'campaign-c1-repo',
    });
    expect(w.backfilled).toEqual([{ id: 'a1', runId: 'run-9' }]);
    expect(w.signals[0]?.payload).toEqual({ runId: 'run-9', status: 'OPEN', targetId: 't1' });
  });

  it('never throws: a failed signal or lookup is logged by id and error name only', async () => {
    const failing = world(
      [{ campaign: campaign(), id: 'a1', n: 1, runId: 'run-1', targetId: 't1' }],
      { signalFails: Object.assign(new Error('secret-token-xyz'), { name: 'ServiceError' }) }
    );
    await expect(
      notifyCampaignsOfPullRequest(failing.fastify, {
        runId: 'run-1',
        status: 'MERGED',
        workflowId: null,
      })
    ).resolves.toBeUndefined();
    const lookup = world([], { lookupFails: true });
    await expect(
      notifyCampaignsOfPullRequest(lookup.fastify, {
        runId: 'run-1',
        status: 'OPEN',
        workflowId: null,
      })
    ).resolves.toBeUndefined();
    expect(JSON.stringify([failing.warn.mock.calls, lookup.warn.mock.calls])).not.toContain(
      'secret-token-xyz'
    );
    expect(failing.warn).toHaveBeenCalledOnce();
  });

  it('does nothing for a pull request with neither a run nor a workflow', async () => {
    const w = world([]);
    await notifyCampaignsOfPullRequest(w.fastify, {
      runId: null,
      status: 'MERGED',
      workflowId: null,
    });
    expect(w.signals).toEqual([]);
  });
});
