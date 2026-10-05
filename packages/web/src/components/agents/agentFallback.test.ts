import { describe, expect, it } from 'vitest';
import type { AgentRow } from '@/hooks/useAgentLibrary';
import { broaderFallbacks } from './agentFallback';

const row = (over: Partial<AgentRow>): AgentRow =>
  ({
    isActive: true,
    key: 'implementer',
    orgId: null,
    scope: 'GLOBAL',
    teamId: null,
    ...over,
  }) as AgentRow;

describe('broaderFallbacks', () => {
  it('is empty when no broader row exists, so deactivating would fail runs', () => {
    const team = row({ scope: 'TEAM' });
    expect(broaderFallbacks(team, [team])).toEqual([]);
  });

  it('lists broader scopes that hold an active row for the same key', () => {
    const team = row({ scope: 'TEAM' });
    const global = row({ scope: 'GLOBAL' });
    expect(broaderFallbacks(team, [team, global])).toEqual(['GLOBAL']);
  });

  it('ignores inactive rows, other keys and narrower scopes', () => {
    const org = row({ scope: 'ORGANIZATION' });
    const rows = [
      org,
      row({ isActive: false, scope: 'GLOBAL' }),
      row({ key: 'reviewer', scope: 'GLOBAL' }),
      row({ scope: 'TEAM' }),
    ];
    expect(broaderFallbacks(org, rows)).toEqual([]);
  });

  it("does not count another organization's row", () => {
    const team = row({ orgId: 'o1', scope: 'TEAM', teamId: 't1' });
    expect(broaderFallbacks(team, [team, row({ orgId: 'o2', scope: 'ORGANIZATION' })])).toEqual([]);
    expect(broaderFallbacks(team, [team, row({ orgId: 'o1', scope: 'ORGANIZATION' })])).toEqual([
      'ORGANIZATION',
    ]);
  });

  it("does not claim an organization fallback when the row's organization is unknown", () => {
    const team = row({ scope: 'TEAM', teamId: 't1' });
    expect(broaderFallbacks(team, [team, row({ orgId: 'o1', scope: 'ORGANIZATION' })])).toEqual([]);
  });

  it("derives a team row's organization from another loaded row of the same team", () => {
    const a = row({ scope: 'TEAM', teamId: 't1' });
    const b = row({ key: 'reviewer', orgId: 'o1', scope: 'TEAM', teamId: 't1' });
    expect(broaderFallbacks(a, [a, b, row({ orgId: 'o1', scope: 'ORGANIZATION' })])).toEqual([
      'ORGANIZATION',
    ]);
  });

  it("counts a team fallback only for the row's own team", () => {
    const tpl = row({ scope: 'WORKFLOW_TEMPLATE', teamId: 't1' });
    expect(broaderFallbacks(tpl, [tpl, row({ scope: 'TEAM', teamId: 't2' })])).toEqual([]);
    expect(broaderFallbacks(tpl, [tpl, row({ scope: 'TEAM', teamId: 't1' })])).toEqual(['TEAM']);
  });
});
