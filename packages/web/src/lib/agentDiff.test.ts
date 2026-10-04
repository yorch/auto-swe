import { describe, expect, it } from 'vitest';
import { diffAgentVersions, lineDiff } from './agentDiff';

const base = {
  credentialId: null,
  description: null,
  inheritsModelFrom: null,
  mcpConnectionId: null,
  modelSpec: 'anthropic/a',
  name: 'Reviewer',
  skillRefs: [],
  systemPrompt: 'one\ntwo',
  toolKeys: null,
};

describe('lineDiff', () => {
  it('marks added, removed and unchanged lines in order', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('handles empty sides', () => {
    expect(lineDiff('', 'a')).toEqual([{ kind: 'added', text: 'a' }]);
    expect(lineDiff('a', '')).toEqual([{ kind: 'removed', text: 'a' }]);
    expect(lineDiff('', '')).toEqual([]);
  });
});

describe('diffAgentVersions', () => {
  it('reports nothing for identical versions', () => {
    expect(diffAgentVersions(base, { ...base })).toEqual([]);
  });

  it('reports the model, the prompt and tools', () => {
    const changes = diffAgentVersions(base, {
      ...base,
      modelSpec: 'openai/b',
      systemPrompt: 'one\nthree',
      toolKeys: ['bash'],
    });
    expect(changes.map((c) => c.label)).toEqual(['Model', 'System prompt', 'Tools']);
    expect(changes[0]).toMatchObject({ after: 'openai/b', before: 'anthropic/a' });
    expect(changes[2]).toMatchObject({ added: ['bash'], removed: ['All tools'] });
  });

  it('describes inheritance instead of a blank model', () => {
    const [change] = diffAgentVersions(base, {
      ...base,
      inheritsModelFrom: 'reviewer',
      modelSpec: null,
    });
    expect(change).toMatchObject({ after: 'Inherits from reviewer', before: 'anthropic/a' });
  });

  it('lists added and removed skills by name, and flags a reorder', () => {
    const ref = (name: string, sortOrder: number) => ({
      id: name,
      skill: { id: name, name },
      skillId: name,
      sortOrder,
    });
    const added = diffAgentVersions(
      { ...base, skillRefs: [ref('tdd', 0)] },
      { ...base, skillRefs: [ref('tdd', 0), ref('lint', 1)] }
    );
    expect(added[0]).toMatchObject({ added: ['lint'], label: 'Skills', removed: [] });
    const reordered = diffAgentVersions(
      { ...base, skillRefs: [ref('a', 0), ref('b', 1)] },
      { ...base, skillRefs: [ref('b', 0), ref('a', 1)] }
    );
    expect(reordered[0]).toMatchObject({ label: 'Skills', reordered: true });
  });

  it('names an MCP connection through the lookup', () => {
    const [change] = diffAgentVersions(
      base,
      { ...base, mcpConnectionId: 'm1' },
      { mcp: new Map([['m1', 'Docs server']]) }
    );
    expect(change).toMatchObject({ after: 'Docs server', before: 'None' });
  });
});
