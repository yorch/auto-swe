import { describe, expect, it } from 'vitest';
import { diffFields, orientVersions } from './specDiff';

describe('diffFields', () => {
  it('reports only the fields that differ', () => {
    const changes = diffFields(
      { next: 'a', step: 'x', type: 'step' },
      { next: 'b', step: 'x', type: 'step' }
    );
    expect(changes).toEqual([{ after: 'b', before: 'a', kind: 'changed', path: 'next' }]);
  });

  it('marks added and removed keys and descends into nested objects', () => {
    const changes = diffFields(
      { config: { a: 1, b: 2 }, gone: true },
      { added: 'x', config: { a: 1, b: 3 } }
    );
    expect(changes.map((c) => `${c.kind}:${c.path}`)).toEqual([
      'added:added',
      'changed:config.b',
      'removed:gone',
    ]);
  });

  it('compares arrays as whole values', () => {
    expect(diffFields({ l: [1, 2] }, { l: [1, 2] })).toEqual([]);
    expect(diffFields({ l: [1, 2] }, { l: [1, 3] })).toHaveLength(1);
  });
});

describe('orientVersions', () => {
  it('puts the lower version before the higher one', () => {
    expect(orientVersions(3, 1)).toEqual({ after: 3, before: 1 });
    expect(orientVersions(1, 3)).toEqual({ after: 3, before: 1 });
  });
  it('flips when reversed', () => {
    expect(orientVersions(1, 3, true)).toEqual({ after: 1, before: 3 });
  });
});
