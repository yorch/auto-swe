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

  it('announces loading as a busy status naming what loads', () => {
    render(
      <QueryBoundary isLoading label="runs">
        content
      </QueryBoundary>
    );
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toContain('Loading runs');
    expect(screen.queryByText('content')).toBeNull();
  });

  it('falls back to a bare "Loading" label', () => {
    render(<QueryBoundary isLoading>content</QueryBoundary>);
    expect(screen.getByRole('status').textContent).toBe('Loading');
  });

  it('renders the rows skeleton by default, one line per requested row', () => {
    const { container } = render(
      <QueryBoundary isLoading label="things" rows={3}>
        content
      </QueryBoundary>
    );
    expect(screen.getByRole('status').textContent).toBe('Loading things');
    expect(container.querySelectorAll('.flex.items-center.gap-4').length).toBe(3);
  });

  it('renders the cards skeleton', () => {
    const { container } = render(
      <QueryBoundary isLoading label="things" rows={4} shape="cards">
        content
      </QueryBoundary>
    );
    expect(screen.getByRole('status').textContent).toBe('Loading things');
    expect(container.querySelectorAll('.grid > .rounded-lg').length).toBe(4);
  });

  it('renders the form skeleton', () => {
    const { container } = render(
      <QueryBoundary isLoading label="settings" rows={2} shape="form">
        content
      </QueryBoundary>
    );
    expect(screen.getByRole('status').textContent).toBe('Loading settings');
    expect(container.querySelectorAll('.space-y-2').length).toBe(2);
  });

  it('renders the detail skeleton', () => {
    const { container } = render(
      <QueryBoundary isLoading label="run" shape="detail">
        content
      </QueryBoundary>
    );
    expect(screen.getByRole('status').textContent).toBe('Loading run');
    expect(container.querySelector('.h-24')).toBeTruthy();
  });

  it('lets a caller supply its own skeleton', () => {
    render(
      <QueryBoundary isLoading loading={<div role="status">Custom shape</div>}>
        content
      </QueryBoundary>
    );
    expect(screen.getByRole('status').textContent).toBe('Custom shape');
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
