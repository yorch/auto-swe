import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  activityInfo: vi.fn(),
  connection: vi.fn(),
  dataset: vi.fn(),
  ledger: vi.fn(),
  run: vi.fn(),
  team: vi.fn(),
}));

vi.mock('@temporalio/activity', () => ({ activityInfo: h.activityInfo }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findUnique: h.ledger },
    connection: { findUnique: h.connection },
    evalDataset: { findUnique: h.dataset },
    team: { findUnique: h.team },
    workflowRun: { findUnique: h.run },
  },
}));

import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import {
  currentSpendOwner,
  ownerOfConnection,
  ownerOfDataset,
  ownerOfTeam,
  withSpendOwner,
} from './spendOwner.js';

const team = (id: string) => ({ id, orgId: `org-of-${id}` });

beforeEach(() => {
  vi.resetAllMocks();
  _resetConfigCacheForTests();
  h.activityInfo.mockReturnValue({ workflowExecution: { workflowId: 'wf-1' } });
  h.run.mockResolvedValue(null);
  h.ledger.mockResolvedValue(null);
});

describe('currentSpendOwner', () => {
  it("takes the run's own repository over every other source", async () => {
    h.run.mockResolvedValue({
      channel: { team: team('chan') },
      connection: { team: team('child') },
      template: { team: team('tpl') },
      workRequest: { connection: { team: team('request') } },
    });
    h.ledger.mockResolvedValue({ repository: { team: team('ledger') } });
    expect(await currentSpendOwner()).toEqual({ orgId: 'org-of-child', teamId: 'child' });
  });

  it('falls back through the ledger, then the template', async () => {
    h.ledger.mockResolvedValue({ repository: { team: team('ledger') } });
    expect(await currentSpendOwner()).toEqual({ orgId: 'org-of-ledger', teamId: 'ledger' });

    _resetConfigCacheForTests();
    h.ledger.mockResolvedValue(null);
    h.run.mockResolvedValue({ channel: null, connection: null, template: { team: team('tpl') } });
    expect(await currentSpendOwner()).toEqual({ orgId: 'org-of-tpl', teamId: 'tpl' });
  });

  it('prefers what the activity declared, without touching the workflow rows', async () => {
    const owner = await withSpendOwner(Promise.resolve({ orgId: 'o', teamId: 't' }), () =>
      currentSpendOwner()
    );
    expect(owner).toEqual({ orgId: 'o', teamId: 't' });
    expect(h.run).not.toHaveBeenCalled();
  });

  it('attributes to nobody when a declared owner fails to resolve', async () => {
    const owner = await withSpendOwner(Promise.reject(new Error('db down')), () =>
      currentSpendOwner()
    );
    expect(owner).toEqual({});
  });

  it('attributes to nobody outside an activity or when the lookup fails, never throwing', async () => {
    h.activityInfo.mockImplementation(() => {
      throw new Error('activity context not initialized');
    });
    expect(await currentSpendOwner()).toEqual({});

    h.activityInfo.mockReturnValue({ workflowExecution: { workflowId: 'wf-2' } });
    h.run.mockRejectedValue(new Error('db down'));
    expect(await currentSpendOwner()).toEqual({});
  });

  it('does not cache "nobody", so a lookup that raced the run rows retries', async () => {
    expect(await currentSpendOwner()).toEqual({});
    h.ledger.mockResolvedValue({ repository: { team: team('late') } });
    expect(await currentSpendOwner()).toEqual({ orgId: 'org-of-late', teamId: 'late' });
  });
});

describe('owner lookups', () => {
  it('reads a team, a connection and a dataset', async () => {
    h.team.mockResolvedValue(team('t'));
    h.connection.mockResolvedValue({ team: team('c') });
    expect(await ownerOfTeam('t')).toEqual({ orgId: 'org-of-t', teamId: 't' });
    expect(await ownerOfTeam(null)).toEqual({});
    expect(await ownerOfConnection('conn')).toEqual({ orgId: 'org-of-c', teamId: 'c' });

    h.dataset.mockResolvedValue({ orgId: 'org-only', teamId: null });
    expect(await ownerOfDataset('d')).toEqual({ orgId: 'org-only' });
    h.dataset.mockResolvedValue({ orgId: null, teamId: null });
    expect(await ownerOfDataset('d')).toEqual({});
  });
});
