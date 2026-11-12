// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BackLink } from './BackLink';

afterEach(cleanup);
describe('BackLink', () => {
  it('names and links to the parent list with a decorative arrow', () => {
    const { container } = render(<BackLink href="/runs" label="All runs" />);
    expect(screen.getByRole('link', { name: 'All runs' }).getAttribute('href')).toBe('/runs');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
