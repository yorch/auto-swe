// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { DiffRenderer } from './DiffRenderer';

beforeEach(() => stubDialogPrototype());
afterEach(cleanup);

describe('DiffRenderer expand', () => {
  it('opens the full diff in a near-full-viewport dialog', () => {
    render(<DiffRenderer content={'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-x\n+y\n'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    const dialog = document.querySelector('dialog');
    expect(dialog?.className).toContain('w-[96vw]');
  });
});

describe('DiffRenderer files', () => {
  const TWO = [
    'diff --git a/a.ts b/a.ts',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    'diff --git a/b.ts b/b.ts',
    '@@ -1 +1 @@',
    '-p',
    '+q',
    '',
  ].join('\n');

  it('shows every file open, with the totals', () => {
    render(<DiffRenderer content={TWO} />);
    // The totals are drawn inline and again inside the expand dialog.
    expect(screen.getAllByText('2 files changed').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(2);
  });

  it('closes and reopens one file without touching the other', () => {
    render(<DiffRenderer content={TWO} />);
    const expanded = (name: RegExp) =>
      screen.getByRole('button', { name }).getAttribute('aria-expanded');
    fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }));
    expect(expanded(/a\.ts/)).toBe('false');
    expect(expanded(/b\.ts/)).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }));
    expect(expanded(/a\.ts/)).toBe('true');
  });

  it('makes a hidden direction character in a diff line visible', () => {
    render(<DiffRenderer content={'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-x\n+y‮\n'} />);
    expect(document.body.textContent).toContain('y⟨U+202E⟩');
  });

  it('shows text that is not a diff as plain text', () => {
    render(<DiffRenderer content="just a plan" />);
    expect(screen.getByText('just a plan')).toBeTruthy();
  });

  it('renders nothing for empty content', () => {
    const { container } = render(<DiffRenderer content="" />);
    expect(container.textContent).toBe('');
  });
});
