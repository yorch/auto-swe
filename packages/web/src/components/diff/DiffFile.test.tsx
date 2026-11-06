// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFilePatch } from '../approvals/diffParse';
import { DiffFile, type DiffFileProps, diffLineId } from './DiffFile';

afterEach(cleanup);

const PATCH = ['@@ -10,3 +10,4 @@ fn', ' keep', '-old', '+new', '+extra'].join('\n');

function props(over: Partial<DiffFileProps> = {}): DiffFileProps {
  const parsed = parseFilePatch(PATCH);
  return {
    added: parsed.added,
    lines: parsed.lines,
    name: 'src/a.ts',
    onToggle: () => undefined,
    open: true,
    removed: parsed.removed,
    ...over,
  };
}

describe('DiffFile', () => {
  it('shows the name and the counts in a header that toggles the body', () => {
    const onToggle = vi.fn();
    render(<DiffFile {...props({ onToggle })} />);
    const header = screen.getByRole('button', { name: /src\/a\.ts/ });
    expect(header.textContent).toContain('+2');
    expect(header.textContent).toContain('−1');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('is controlled: the caller decides whether the body shows', () => {
    const { rerender } = render(<DiffFile {...props({ open: false })} />);
    expect(screen.queryByText('keep')).toBeNull();
    expect(screen.getByRole('button', { name: /src\/a\.ts/ }).getAttribute('aria-expanded')).toBe(
      'false'
    );
    rerender(<DiffFile {...props({ open: true })} />);
    expect(screen.getByText('keep', { exact: false })).toBeTruthy();
  });

  it('draws no rows at all while closed', () => {
    const { container } = render(<DiffFile {...props({ open: false })} />);
    expect(container.querySelectorAll('.whitespace-pre')).toHaveLength(0);
  });

  describe('anchors', () => {
    it('gives the section an id and each line of the new side one, but not removed lines', () => {
      const { container } = render(<DiffFile {...props({ anchorId: 'f-1' })} />);
      expect(container.querySelector('section')?.id).toBe('f-1');
      expect(container.querySelector(`#${diffLineId('f-1', 10)}`)).toBeTruthy();
      expect(container.querySelector(`#${diffLineId('f-1', 11)}`)).toBeTruthy();
      expect(container.querySelector(`#${diffLineId('f-1', 12)}`)).toBeTruthy();
      // The removed line sits at old line 11 and has no place on the new side.
      expect(container.querySelectorAll('[id^="f-1-L"]')).toHaveLength(3);
    });

    it('sets no ids when it has no anchor', () => {
      const { container } = render(<DiffFile {...props()} />);
      expect(container.querySelectorAll('[id]')).toHaveLength(0);
    });
  });

  describe('annotations', () => {
    it('draws a note under the line of the new side with that number', () => {
      render(
        <DiffFile
          {...props({ annotations: new Map([[11, <p key="n">a finding on line 11</p>]]) })}
        />
      );
      const note = screen.getByText('a finding on line 11');
      const row = note.closest('div[class*="border-y"]')?.previousElementSibling;
      expect(row?.textContent).toContain('+new');
    });

    it('never hangs a note on a removed line', () => {
      // Old line 11 is the removed one; only the new side's numbers address a note.
      render(<DiffFile {...props({ annotations: new Map([[0, <p key="n">orphan</p>]]) })} />);
      expect(screen.queryByText('orphan')).toBeNull();
    });
  });

  describe('large files', () => {
    const many = (n: number) =>
      parseFilePatch(
        [`@@ -1,${n} +1,${n} @@`, ...Array.from({ length: n }, (_, i) => ` line ${i}`)].join('\n')
      );

    it('draws a limited number of rows and offers the rest', () => {
      const parsed = many(50);
      render(<DiffFile {...props({ lines: parsed.lines, rowLimit: 10 })} />);
      // The hunk header counts as a row.
      expect(screen.getByText(/41 more lines not drawn/)).toBeTruthy();
      expect(screen.queryByText('line 20', { exact: false })).toBeNull();
    });

    it('draws more on request, and everything on "Show all"', () => {
      const parsed = many(50);
      render(<DiffFile {...props({ lines: parsed.lines, rowLimit: 10 })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      expect(screen.getByText(/31 more lines not drawn/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
      expect(screen.queryByText(/more lines not drawn/)).toBeNull();
      expect(screen.getByText('line 49', { exact: false })).toBeTruthy();
    });

    it('offers nothing when everything is drawn', () => {
      render(<DiffFile {...props()} />);
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });
  });

  describe('repository text', () => {
    it('makes a hidden direction character in a line or a name visible', () => {
      const patch = ['@@ -1 +1 @@', '+const a = "‮evil";'].join('\n');
      const parsed = parseFilePatch(patch);
      const { container } = render(
        <DiffFile {...props({ ...parsed, name: 'src/‮a.ts', previousName: 'old​.ts' })} />
      );
      expect(container.textContent).toContain('⟨U+202E⟩evil');
      expect(container.textContent).toContain('src/⟨U+202E⟩a.ts');
      expect(container.textContent).toContain('old⟨U+200B⟩.ts');
      expect(container.textContent).not.toContain('‮');
    });

    it('keeps a tab, which is layout in code', () => {
      const parsed = parseFilePatch(['@@ -1 +1 @@', '+\tindented'].join('\n'));
      const { container } = render(<DiffFile {...props({ ...parsed })} />);
      expect(container.textContent).toContain('\tindented');
    });

    it('renders markup as text', () => {
      const parsed = parseFilePatch(['@@ -1 +1 @@', '+<img src=x onerror=alert(1)>'].join('\n'));
      const { container } = render(<DiffFile {...props({ ...parsed })} />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    });
  });

  it('shows where a renamed file came from, and says so to a screen reader', () => {
    render(<DiffFile {...props({ name: 'new.ts', previousName: 'old.ts' })} />);
    const header = screen.getByRole('button', { name: /new\.ts/ });
    expect(header.textContent).toContain('old.ts');
    expect(header.textContent).toContain('renamed to');
  });

  it('puts what the caller gives beside the name, outside the toggle', () => {
    const onToggle = vi.fn();
    render(
      <DiffFile
        {...props({ headerExtra: <input aria-label="viewed" type="checkbox" />, onToggle })}
      />
    );
    fireEvent.click(screen.getByLabelText('viewed'));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('DiffFile in split mode', () => {
  const split = (over: Partial<DiffFileProps> = {}) => props({ mode: 'split', ...over });
  /** The two sides of every row that has a pair, as text. */
  const sides = (container: HTMLElement) =>
    [...container.querySelectorAll('.grid.grid-cols-2')].map((grid) =>
      [...grid.children].map((cell) => cell.textContent?.replace(/^\d*/, '') ?? '')
    );

  it('draws the old line beside the new one, and an unchanged line on both sides', () => {
    const { container } = render(<DiffFile {...split()} />);
    expect(sides(container)).toEqual([
      ['keep', 'keep'],
      ['old', 'new'],
      ['', 'extra'],
    ]);
  });

  it('leaves unified mode as it was by default', () => {
    const { container } = render(<DiffFile {...props()} />);
    expect(container.querySelectorAll('.grid.grid-cols-2')).toHaveLength(0);
  });

  it('numbers each side from its own counter, and hides the gutters from a screen reader', () => {
    const { container } = render(<DiffFile {...split()} />);
    const first = container.querySelector('.grid.grid-cols-2');
    const gutters = [...(first?.querySelectorAll('[aria-hidden="true"]') ?? [])];
    expect(gutters.map((g) => g.textContent)).toEqual(['10', '10']);
  });

  it('puts the anchor on the new side only, and never on a removed line', () => {
    const { container } = render(<DiffFile {...split({ anchorId: 'f-1' })} />);
    expect(container.querySelector('#f-1-L10')).toBeTruthy();
    expect(container.querySelector('#f-1-L11')).toBeTruthy();
    expect(container.querySelector('#f-1-L12')).toBeTruthy();
    expect(container.querySelectorAll('[id^="f-1-L"]')).toHaveLength(3);
    const removed = [...container.querySelectorAll('.grid.grid-cols-2')][1]?.children[0];
    expect(removed?.id).toBe('');
    expect(removed?.textContent).toContain('old');
  });

  it('draws a note under the row of the new line it names, across both sides', () => {
    render(
      <DiffFile {...split({ annotations: new Map([[11, <p key="n">a finding on line 11</p>]]) })} />
    );
    const note = screen.getByText('a finding on line 11');
    const row = note.closest('div[class*="border-y"]')?.previousElementSibling;
    expect(row?.textContent).toContain('old');
    expect(row?.textContent).toContain('new');
  });

  it('draws a hunk header across both sides', () => {
    const { container } = render(<DiffFile {...split()} />);
    expect(container.textContent).toContain('@@ -10,3 +10,4 @@ fn');
    expect(container.querySelectorAll('.grid.grid-cols-2')).toHaveLength(3);
  });

  it('caps rows, not lines, and offers the rest', () => {
    const many = parseFilePatch(
      ['@@ -1,30 +1,30 @@', ...Array.from({ length: 30 }, (_, i) => ` line ${i}`)].join('\n')
    );
    render(<DiffFile {...split({ lines: many.lines, rowLimit: 10 })} />);
    // A header row and 29 unchanged ones are left after the first ten rows.
    expect(screen.getByText(/21 more rows not drawn/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.queryByText(/more rows not drawn/)).toBeNull();
    // An unchanged line is drawn once on each side.
    expect(screen.getAllByText('line 29', { exact: false })).toHaveLength(2);
  });

  it('draws nothing while closed', () => {
    const { container } = render(<DiffFile {...split({ open: false })} />);
    expect(container.querySelectorAll('.grid.grid-cols-2')).toHaveLength(0);
  });

  it('shows hidden characters in either side, and markup as text', () => {
    const parsed = parseFilePatch(
      ['@@ -1 +1 @@', '-a‮', '+<img src=x onerror=alert(1)>'].join('\n')
    );
    const { container } = render(<DiffFile {...split({ ...parsed })} />);
    expect(container.textContent).toContain('a⟨U+202E⟩');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('the changed words of an edited line', () => {
  const EDIT = [
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-const total = price * count;',
    '+const total = price * quantity;',
  ].join('\n');
  const edit = (over: Partial<DiffFileProps> = {}) => {
    const parsed = parseFilePatch(EDIT);
    return props({ added: parsed.added, lines: parsed.lines, removed: parsed.removed, ...over });
  };
  const marked = (container: HTMLElement) =>
    [...container.querySelectorAll('mark')].map((m) => m.textContent);

  it.each(['unified', 'split'] as const)('are marked, and only they, in %s mode', (mode) => {
    const { container } = render(<DiffFile {...edit({ mode })} />);
    expect(marked(container)).toEqual(['count', 'quantity']);
  });

  it('keep the patch’s own marker out of the marks in unified mode', () => {
    const { container } = render(<DiffFile {...edit()} />);
    expect(container.textContent).toContain('+const total = price * quantity;');
    expect(container.textContent).toContain('-const total = price * count;');
    expect(marked(container).join('')).not.toMatch(/[+-]/);
  });

  it('are not marked for a rewrite, where almost nothing is shared', () => {
    const parsed = parseFilePatch(
      ['@@ -1 +1 @@', '-return a;', '+throw new Error("nope");'].join('\n')
    );
    const { container } = render(<DiffFile {...props({ ...parsed })} />);
    expect(marked(container)).toEqual([]);
  });

  it('are not marked for an addition with nothing removed, or an unchanged line', () => {
    const parsed = parseFilePatch(['@@ -1,1 +1,2 @@', ' keep', '+brand new line'].join('\n'));
    const { container } = render(<DiffFile {...props({ ...parsed })} />);
    expect(marked(container)).toEqual([]);
  });

  it('leave the text of the line whole', () => {
    const { container } = render(<DiffFile {...edit()} />);
    const text = container.textContent ?? '';
    expect(text).toContain('const total = price * count;');
    expect(text).toContain('const total = price * quantity;');
  });

  it('still show hidden characters, inside a mark or outside one', () => {
    const parsed = parseFilePatch(['@@ -1 +1 @@', '-let a = one‮;', '+let a = two‮;'].join('\n'));
    const { container } = render(<DiffFile {...props({ ...parsed })} />);
    expect(container.textContent).toContain('⟨U+202E⟩');
    expect(container.textContent).not.toContain('‮');
  });

  it('are not worked out while the file is closed', () => {
    const { container } = render(<DiffFile {...edit({ open: false })} />);
    expect(marked(container)).toEqual([]);
  });

  it('are drawn only for the lines that are drawn', () => {
    const pairs = Array.from({ length: 40 }, (_, i) => [
      `-let value${i} = first;`,
      `+let value${i} = second;`,
    ]).flat();
    const parsed = parseFilePatch(['@@ -1,40 +1,40 @@', ...pairs].join('\n'));
    const { container } = render(<DiffFile {...props({ ...parsed, rowLimit: 4 })} />);
    // Four lines are drawn: the header, one edit pair and the removal of the next, so a few marks,
    // not the eighty a full draw would give.
    expect(container.querySelectorAll('mark').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('mark').length).toBeLessThan(10);
  });
});

describe('moved lines', () => {
  const PATCH_MOVED = ['@@ -1,3 +1,3 @@', ' keep', '-moved away', '+moved here'].join('\n');
  const moved = (...indexes: number[]) => new Set(indexes);
  const parsed = parseFilePatch(PATCH_MOVED);
  // 0 is the hunk header, 1 the unchanged line, 2 the removed one, 3 the added one.
  const flagged = (container: HTMLElement) => container.querySelectorAll('.border-info-400');

  it.each(['unified', 'split'] as const)(
    'are marked, with a name for a screen reader, in %s mode',
    (mode) => {
      const { container } = render(
        <DiffFile {...props({ ...parsed, mode, moved: moved(2, 3) })} />
      );
      expect(flagged(container)).toHaveLength(2);
      expect(container.textContent?.match(/Moved: /g)).toHaveLength(2);
    }
  );

  it('mark a removed line and an added one independently', () => {
    const { container } = render(<DiffFile {...props({ ...parsed, moved: moved(3) })} />);
    expect(flagged(container)).toHaveLength(1);
    expect(flagged(container)[0]?.textContent).toContain('moved here');
  });

  it('never mark an unchanged line, whatever index is given', () => {
    const { container } = render(<DiffFile {...props({ ...parsed, moved: moved(1) })} />);
    expect(flagged(container)).toHaveLength(0);
  });

  it('mark nothing when none are given', () => {
    const { container } = render(<DiffFile {...props({ ...parsed })} />);
    expect(flagged(container)).toHaveLength(0);
    expect(container.textContent).not.toContain('Moved: ');
  });
});
