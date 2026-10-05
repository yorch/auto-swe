import { describe, expect, it } from 'vitest';
import type { AgentRow } from '@/hooks/useAgentLibrary';
import { broaderFallbacks } from './agentFallback';

const row = (over: Partial<AgentRow>): AgentRow =>
  ({ isActive: true, key: 'implementer', orgId: null, scope: 'GLOBAL', ...over }) as AgentRow;

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
    const team = row({ orgId: 'o1', scope: 'TEAM' });
    expect(broaderFallbacks(team, [team, row({ orgId: 'o2', scope: 'ORGANIZATION' })])).toEqual([]);
  });
});
