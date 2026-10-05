import { describe, expect, it } from 'vitest';
import { diffHref } from './PromoteVersionModal';

describe('diffHref', () => {
  it('opens active -> newer in the default direction', () => {
    expect(diffHref('t1', 2, 3)).toBe('/workflows/library/t1/diff?a=2&b=3');
  });

  it('opens reversed when promoting an older version, matching the summary counts', () => {
    expect(diffHref('t1', 3, 2)).toBe('/workflows/library/t1/diff?a=3&b=2&reversed=1');
  });
});
