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
