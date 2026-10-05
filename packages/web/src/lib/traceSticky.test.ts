import { describe, expect, it } from 'vitest';
import { FILTER_BAR_DESKTOP_PX, FILTER_BAR_HEIGHT_VAR, groupHeaderTop } from './traceSticky';

describe('groupHeaderTop', () => {
  it('sticks to the top of the scroller when there is no filter bar', () => {
    expect(groupHeaderTop(false)).toBe('top-0');
  });

  it('keeps the desktop offset at lg and reads the measured bar height below it', () => {
    const classes = groupHeaderTop(true).split(' ');
    expect(classes).toContain(`lg:top-[${FILTER_BAR_DESKTOP_PX}px]`);
    expect(classes).toContain(`top-[var(${FILTER_BAR_HEIGHT_VAR},${FILTER_BAR_DESKTOP_PX}px)]`);
  });
});
