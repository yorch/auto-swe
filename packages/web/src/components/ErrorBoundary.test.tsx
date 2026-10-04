// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

afterEach(cleanup);

function Boom({ explode }: { explode: boolean }) {
  if (explode) {
    throw new Error('kaboom');
  }
  return <p>fine</p>;
}

describe('ErrorBoundary', () => {
  it('shows recovery actions and clears when the reset key changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Boom explode />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy();

    rerender(
      <ErrorBoundary resetKey="/b">
        <Boom explode={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('fine')).toBeTruthy();
  });
});
