// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Breadcrumbs } from './Breadcrumbs';

afterEach(cleanup);

describe('Breadcrumbs', () => {
  it('links ancestors that have an href and marks only the leaf as current', () => {
    render(
      <Breadcrumbs
        items={[{ label: 'Work' }, { href: '/runs', label: 'All runs' }, { label: 'Run 1a2b' }]}
      />
    );
    expect(screen.getByRole('link', { name: 'All runs' }).getAttribute('href')).toBe('/runs');
    expect(screen.queryByRole('link', { name: 'Work' })).toBeNull();
    const current = document.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe('Run 1a2b');
  });

  it('never links the leaf, even when it has an href', () => {
    render(
      <Breadcrumbs
        items={[
          { href: '/a', label: 'A' },
          { href: '/b', label: 'B' },
        ]}
      />
    );
    expect(screen.queryByRole('link', { name: 'B' })).toBeNull();
  });
});
