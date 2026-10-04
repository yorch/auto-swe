// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryBoundary } from './QueryBoundary';

afterEach(cleanup);

describe('QueryBoundary', () => {
  it('offers Retry on an error when given a retry handler', () => {
    const onRetry = vi.fn();
    render(
      <QueryBoundary
        error={new Error('nope')}
        isError
        isLoading={false}
        label="teams"
        onRetry={onRetry}
      >
        content
      </QueryBoundary>
    );
    expect(screen.getByText(/Could not load teams: nope/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('announces loading as a status', () => {
    render(<QueryBoundary isLoading>content</QueryBoundary>);
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('QueryBoundary retry while refetching', () => {
  it('disables Retry and says so while a refetch is running', () => {
    render(
      <QueryBoundary error={new Error('x')} isError isFetching isLoading={false} onRetry={() => {}}>
        content
      </QueryBoundary>
    );
    const button = screen.getByRole('button', { name: 'Retrying…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
