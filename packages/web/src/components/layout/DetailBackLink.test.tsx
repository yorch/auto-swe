// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEntityTitleStore } from '@/stores/entityTitleStore';
import { resetNavigation } from '@/test/mockNavigation';
import { DetailBackLink } from './DetailBackLink';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
beforeEach(() => useEntityTitleStore.setState({ entry: null }));
afterEach(cleanup);
describe('shared detail back link', () => {
  it('renders compactly even while a focused detail is loading', () => {
    resetNavigation('', '/runs/id');
    const { container } = render(<DetailBackLink focused />);
    expect(screen.getByRole('link', { name: 'All runs' }).getAttribute('href')).toBe('/runs');
    expect(container.firstElementChild?.className).toContain('shrink-0');
  });
  it('uses a loaded parent and ignores stale metadata from another route', () => {
    resetNavigation('', '/admin/evals/runs/id');
    useEntityTitleStore.setState({
      entry: {
        owner: 'test',
        parent: { href: '/admin/evals/datasets/d', label: 'Dataset' },
        pathname: '/admin/evals/runs/id',
        title: 'Benchmark',
      },
    });
    const { rerender } = render(<DetailBackLink />);
    expect(screen.getByRole('link', { name: 'Dataset' }).getAttribute('href')).toBe(
      '/admin/evals/datasets/d'
    );
    resetNavigation('', '/docs/architecture');
    rerender(<DetailBackLink />);
    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe('/docs');
    expect(screen.queryByText('Dataset')).toBeNull();
  });
  it('renders nothing on list and unknown routes', () => {
    resetNavigation('', '/requests');
    const { container, rerender } = render(<DetailBackLink />);
    expect(container.innerHTML).toBe('');
    resetNavigation('', '/unknown');
    rerender(<DetailBackLink />);
    expect(container.innerHTML).toBe('');
  });
});
