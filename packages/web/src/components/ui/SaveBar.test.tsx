// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveBar } from './SaveBar';

afterEach(cleanup);

const base = { dirtyCount: 0, error: null, onDiscard: vi.fn(), pending: false, saved: false };

describe('SaveBar', () => {
  it('counts unsaved changes and enables Save and Discard', () => {
    render(<SaveBar {...base} dirtyCount={3} />);
    expect(screen.getByText('3 unsaved changes')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('disables Save when nothing changed and says so', () => {
    render(<SaveBar {...base} />);
    expect(screen.getByText('No unsaved changes')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('shows the error in place of the count', () => {
    render(<SaveBar {...base} dirtyCount={1} error="Server said no" />);
    expect(screen.getByText('Server said no')).toBeTruthy();
    expect(screen.queryByText('1 unsaved change')).toBeNull();
  });

  it('confirms a save', () => {
    render(<SaveBar {...base} saved savedMessage="Defaults saved." />);
    expect(screen.getByText('✓ Defaults saved.')).toBeTruthy();
  });
});
