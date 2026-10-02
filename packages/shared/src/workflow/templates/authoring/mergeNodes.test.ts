import { describe, expect, it } from 'vitest';
import { ciLoop } from './ciLoop.js';
import { mergeNodes, statusStamp } from './common.js';
import { openPullRequest } from './openPullRequest.js';
import { reviewLoop } from './reviewLoop.js';
import { validatePhase } from './validatePhase.js';

describe('mergeNodes', () => {
  it('combines disjoint maps, keeping every node', () => {
    const merged = mergeNodes({ a: statusStamp('A', 'b') }, undefined, {
      b: statusStamp('B', 'a'),
    });
    expect(Object.keys(merged)).toEqual(['a', 'b']);
  });

  it('throws on a duplicate id instead of letting the later node replace the earlier', () => {
    expect(() => mergeNodes({ x: statusStamp('A', 'n') }, { x: statusStamp('B', 'n') })).toThrow(
      /duplicate node id 'x'/
    );
  });

  it('throws when two helpers emit the same fixed id', () => {
    // Both emit `setReviewing`, `review`, … : a template that used one twice would
    // silently keep only the second loop's wiring.
    expect(() => mergeNodes(reviewLoop({ approved: 'a' }), reviewLoop({ approved: 'b' }))).toThrow(
      /duplicate node id/
    );
    expect(() =>
      mergeNodes(openPullRequest({ next: 'a' }), openPullRequest({ next: 'b' }))
    ).toThrow(/'openPR'/);
  });

  it('catches a hand-written node that collides with a helper id', () => {
    expect(() =>
      mergeNodes(ciLoop({ fix: false, passed: 'done' }), {
        checkCI: statusStamp('X', 'done'),
      })
    ).toThrow(/'checkCI'/);
  });

  it('is enforced inside the helpers where a caller picks an id', () => {
    expect(() => ciLoop({ fix: { handoff: { repush: 'checkCI' } }, passed: 'done' })).toThrow(
      /'checkCI'/
    );
    expect(() => validatePhase({ next: 'n', stamp: false, successCriteriaId: 'validate' })).toThrow(
      /'validate'/
    );
  });

  it('lets disjoint helpers combine, as the templates do', () => {
    expect(() =>
      mergeNodes(
        validatePhase({ next: 'setImplementing' }),
        reviewLoop({ approved: 'openPR' }),
        openPullRequest({ next: 'waitForCI' }),
        ciLoop({ fix: { handoff: { repush: 'repushAfterCIFix' } }, passed: 'done' })
      )
    ).not.toThrow();
  });
});
