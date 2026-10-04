// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TabBar } from './TabBar';

describe('TabBar', () => {
  it('renders href tabs as links and marks the active one as the current page', () => {
    render(
      <TabBar
        active="runs"
        tabs={[
          { href: '/t/1', id: 'editor', label: 'Editor' },
          { href: '/t/1/runs', id: 'runs', label: 'Runs' },
        ]}
      />
    );
    const runs = screen.getByRole('link', { name: 'Runs' });
    expect(runs.getAttribute('href')).toBe('/t/1/runs');
    expect(runs.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Editor' }).getAttribute('aria-current')).toBeNull();
  });

  it('calls onChange for in-page tabs', () => {
    const onChange = vi.fn();
    render(
      <TabBar
        active="a"
        onChange={onChange}
        tabs={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ]}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('marks the active in-page tab selected and moves with the arrow keys', () => {
    const onChange = vi.fn();
    render(
      <TabBar
        active="a"
        ariaLabel="Filters"
        onChange={onChange}
        tabs={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ]}
      />
    );
    expect(screen.getByRole('tablist', { name: 'Filters' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'A' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
