// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UnifiedDiff } from './UnifiedDiff';

describe('UnifiedDiff', () => {
  it('marks additions, removals, hunk headers and context', () => {
    const { container } = render(
      <UnifiedDiff text={'@@ -1,2 +1,2 @@\n keep\n-old line\n+new line'} />
    );
    const kinds = [...container.querySelectorAll('[data-kind]')].map((e) => [
      e.getAttribute('data-kind'),
      e.textContent,
    ]);
    expect(kinds).toEqual([
      ['hunk', '@@ -1,2 +1,2 @@'],
      ['ctx', ' keep'],
      ['del', '-old line'],
      ['add', '+new line'],
    ]);
    expect(screen.getByText('+new line').className).toContain('text-moss-400');
    expect(screen.getByText('-old line').className).toContain('text-brick-400');
  });

  it('shows direction-changing and zero-width characters instead of acting on them', () => {
    render(<UnifiedDiff text={'+ run ‮evil‬\n+zero​width\ttab'} />);
    expect(screen.getByText('+ run ⟨U+202E⟩evil⟨U+202C⟩')).toBeTruthy();
    // A tab is layout in a text body and stays; the zero-width space is shown.
    expect(
      screen.getByText(
        (_, el) => el?.textContent === '+zero⟨U+200B⟩width\ttab' && !el.children.length
      )
    ).toBeTruthy();
  });

  it('renders repository text as plain text, never as markup', () => {
    const { container } = render(<UnifiedDiff text={'+<img src=x onerror=alert(1)><b>hi</b>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)><b>hi</b>');
  });
});
