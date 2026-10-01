import { describe, expect, it } from 'vitest';
import type { AgentRow } from '@/hooks/useAgentLibrary';
import { buildAgentUpdate } from './agentEditPatch';

const BASE: AgentRow = {
  createdAt: '2026-01-01T00:00:00.000Z',
  credentialId: null,
  description: 'Reviews diffs',
  id: 'a1',
  inheritsModelFrom: null,
  isActive: true,
  isBuiltIn: true,
  isVerified: true,
  key: 'reviewer',
  mcpConnectionId: null,
  modelSpec: 'anthropic/claude-opus-4-8',
  name: 'Reviewer',
  orgId: null,
  origin: 'builtin',
  scope: 'GLOBAL',
  skillRefs: [{ id: 'r1', skill: { id: 's1', name: 'S1' }, skillId: 's1', sortOrder: 0 }],
  systemPrompt: 'You review code.',
  teamId: null,
  toolKeys: null,
  version: 3,
  workflowTemplateId: null,
};

describe('buildAgentUpdate', () => {
  it('sends only the name on a rename — never the unchanged prompt', () => {
    expect(buildAgentUpdate(BASE, { ...BASE, name: 'Code Reviewer' })).toEqual({
      name: 'Code Reviewer',
    });
  });

  it('sends nothing when nothing changed', () => {
    expect(buildAgentUpdate(BASE, { ...BASE })).toEqual({});
  });

  it('clears an emptied optional field with null', () => {
    expect(buildAgentUpdate(BASE, { ...BASE, modelSpec: '  ' })).toEqual({ modelSpec: null });
  });

  it('sends a changed prompt, tool list and skill order', () => {
    const draft: AgentRow = {
      ...BASE,
      skillRefs: [
        { id: 'x', skill: { id: 's2', name: 'S2' }, skillId: 's2', sortOrder: 0 },
        ...BASE.skillRefs,
      ],
      systemPrompt: 'You review code carefully.',
      toolKeys: ['bash'],
    };
    expect(buildAgentUpdate(BASE, draft)).toEqual({
      skillRefs: [
        { skillId: 's2', sortOrder: 0 },
        { skillId: 's1', sortOrder: 1 },
      ],
      systemPrompt: 'You review code carefully.',
      toolKeys: ['bash'],
    });
  });
});
