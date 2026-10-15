// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpandablePre } from './ExpandablePre';

// jsdom does no layout, so scrollHeight/clientHeight are 0 unless a test says otherwise.
function fakeHeights(scrollHeight: number, clientHeight: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
}

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

describe('ExpandablePre', () => {
  it('never scrolls vertically, so the wheel always reaches the surrounding pane', () => {
    fakeHeights(100, 100);
    const { container } = render(<ExpandablePre collapsedHeight="10rem">short</ExpandablePre>);
    const pre = container.querySelector('pre') as HTMLPreElement;
    expect(pre.className).toContain('overflow-y-hidden');
    expect(pre.className).not.toMatch(/(^|\s)overflow-(y-)?auto(\s|$)/);
    expect(pre.style.maxHeight).toBe('10rem');
  });

  it('shows no toggle when the content fits', () => {
    fakeHeights(100, 100);
    render(<ExpandablePre>short</ExpandablePre>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('cuts tall content and expands it in place', () => {
    fakeHeights(900, 288);
    const { container } = render(<ExpandablePre>tall</ExpandablePre>);
    const pre = container.querySelector('pre') as HTMLPreElement;
    const toggle = screen.getByRole('button', { name: 'Show all' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(pre.id);

    fireEvent.click(toggle);
    expect(pre.style.maxHeight).toBe('');
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  it('shows the toggle when the caller holds text back, even if what renders fits', () => {
    fakeHeights(100, 100);
    const onExpandedChange = vi.fn();
    render(
      <ExpandablePre
        expanded={false}
        hasMore
        labels={{ less: 'show less', more: 'show all (9,000 chars)' }}
        onExpandedChange={onExpandedChange}
      >
        capped
      </ExpandablePre>
    );
    fireEvent.click(screen.getByRole('button', { name: 'show all (9,000 chars)' }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it('does not let a toggle click reach a clickable parent', () => {
    // Trace rows select on click; anything above the React root stands in for one.
    fakeHeights(900, 288);
    const onOuterClick = vi.fn();
    document.body.addEventListener('click', onOuterClick);
    render(<ExpandablePre>tall</ExpandablePre>);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    document.body.removeEventListener('click', onOuterClick);
    expect(onOuterClick).not.toHaveBeenCalled();
  });
});
