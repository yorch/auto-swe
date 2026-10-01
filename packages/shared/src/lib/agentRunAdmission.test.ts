import { describe, expect, it, vi } from 'vitest';
import {
  type AgentRunSlot,
  decideAdmission,
  loadAgentRunSlots,
  wouldAdmitNewRun,
} from './agentRunAdmission.js';

const at = (s: number) => new Date(1_700_000_000_000 + s * 1000);
const slot = (id: string, team: string | null, t: number): AgentRunSlot => ({
  launchedAt: at(t),
  teamId: team,
  workflowId: id,
});

describe('decideAdmission (worker authority)', () => {
  const limits = { global: 3, perTeam: 2 };

  it('admits the oldest runs and refuses a newer one past the global cap', () => {
    const runs = [slot('a', 't1', 1), slot('b', 't2', 2), slot('c', 't3', 3), slot('d', 't4', 4)];
    expect(decideAdmission(runs, { teamId: 't3', workflowId: 'c' }, limits).admitted).toBe(true);
    expect(decideAdmission(runs, { teamId: 't4', workflowId: 'd' }, limits)).toEqual({
      admitted: false,
      reason: 'global_limit',
    });
  });

  it('fails closed when the run is in flight but not under the team it claims', () => {
    const runs = [slot('a', 't1', 1)];
    expect(decideAdmission(runs, { teamId: 't2', workflowId: 'a' }, limits)).toEqual({
      admitted: false,
      reason: 'unknown_run',
    });
    expect(decideAdmission(runs, { teamId: null, workflowId: 'a' }, limits)).toEqual({
      admitted: false,
      reason: 'unknown_run',
    });
  });

  it('applies the per-team cap on the team’s own runs only', () => {
    const runs = [slot('a', 't1', 1), slot('b', 't1', 2), slot('c', 't1', 3), slot('d', 't2', 4)];
    expect(decideAdmission(runs, { teamId: 't1', workflowId: 'c' }, limits)).toEqual({
      admitted: false,
      reason: 'team_limit',
    });
    // Another team is not held back by t1's backlog.
    expect(
      decideAdmission(runs, { teamId: 't2', workflowId: 'd' }, { global: 10, perTeam: 2 }).admitted
    ).toBe(true);
  });

  it('two racing launches at a limit of one: exactly one proceeds', () => {
    // Same launch instant; the workflow id breaks the tie deterministically.
    const runs = [slot('run-b', 't', 5), slot('run-a', 't', 5)];
    const one = { global: 1, perTeam: 1 };
    const a = decideAdmission(runs, { teamId: 't', workflowId: 'run-a' }, one).admitted;
    const b = decideAdmission(runs, { teamId: 't', workflowId: 'run-b' }, one).admitted;
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('0 disables agent runs outright, at either level', () => {
    const runs = [slot('a', 't', 1)];
    const self = { teamId: 't', workflowId: 'a' };
    expect(decideAdmission(runs, self, { global: 0, perTeam: 2 })).toEqual({
      admitted: false,
      reason: 'disabled',
    });
    expect(decideAdmission(runs, self, { global: 4, perTeam: 0 })).toEqual({
      admitted: false,
      reason: 'disabled',
    });
  });

  it('fails closed when the run cannot find itself', () => {
    expect(
      decideAdmission([slot('a', 't', 1)], { teamId: 't', workflowId: 'zzz' }, limits)
    ).toEqual({ admitted: false, reason: 'unknown_run' });
  });
});

describe('wouldAdmitNewRun (gateway friendliness)', () => {
  it('counts the global and team load', () => {
    const runs = [slot('a', 't1', 1), slot('b', 't1', 2)];
    expect(wouldAdmitNewRun(runs, 't1', { global: 5, perTeam: 2 })).toEqual({
      admitted: false,
      reason: 'team_limit',
    });
    expect(wouldAdmitNewRun(runs, 't2', { global: 2, perTeam: 2 })).toEqual({
      admitted: false,
      reason: 'global_limit',
    });
    expect(wouldAdmitNewRun(runs, 't2', { global: 5, perTeam: 2 }).admitted).toBe(true);
    expect(wouldAdmitNewRun([], 't1', { global: 0, perTeam: 2 }).admitted).toBe(false);
  });
});

describe('loadAgentRunSlots', () => {
  it('filters terminal runs in the database query, not in memory', async () => {
    const findMany = vi.fn(async (_args: unknown) => [
      {
        currentStatus: 'IMPLEMENTING',
        repository: { teamId: 't1' },
        temporalWorkflowId: 'w1',
        workRequest: { createdAt: at(1) },
      },
    ]);
    const slots = await loadAgentRunSlots({ activeWorkflow: { findMany } }, 'tpl-1');
    expect(slots).toEqual([{ launchedAt: at(1), teamId: 't1', workflowId: 'w1' }]);
    const arg = findMany.mock.calls[0]?.[0] as unknown as {
      where: { currentStatus: { notIn: string[] }; workRequest: { templateId: string } };
    };
    expect(arg.where.currentStatus.notIn).toEqual(
      expect.arrayContaining(['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'])
    );
    expect(arg.where.workRequest.templateId).toBe('tpl-1');
  });
});
