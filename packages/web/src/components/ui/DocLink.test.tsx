// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DocLink, docHref } from './DocLink';
import { PageHeader } from './PageHeader';

afterEach(cleanup);

describe('DocLink', () => {
  it('links to the doc with a default label', () => {
    render(<DocLink slug="concepts" />);
    const link = screen.getByRole('link', { name: 'Learn more' });
    expect(link.getAttribute('href')).toBe('/docs/concepts');
    expect(link.getAttribute('target')).toBeNull();
    expect(link.textContent).not.toContain('new tab');
  });

  it('opens in a new tab, without opener access, only when asked', () => {
    render(<DocLink newTab slug="concepts" />);
    const link = screen.getByRole('link', { name: 'Learn more (opens in a new tab)' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('adds the anchor and honours a custom label', () => {
    render(<DocLink anchor="workflows" label="About templates" slug="concepts" />);
    expect(screen.getByRole('link', { name: 'About templates' }).getAttribute('href')).toBe(
      '/docs/concepts#workflows'
    );
  });

  it('builds hrefs', () => {
    expect(docHref('agents')).toBe('/docs/agents');
    expect(docHref('agents', '6-skills')).toBe('/docs/agents#6-skills');
  });
});

describe('PageHeader learnMore', () => {
  it('renders no docs link by default', () => {
    render(<PageHeader subtitle="sub" title="Runs" />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders a docs link under the subtitle', () => {
    render(<PageHeader learnMore={{ anchor: 'x', slug: 'evals' }} subtitle="sub" title="Evals" />);
    expect(screen.getByRole('link', { name: 'Learn more' }).getAttribute('href')).toBe(
      '/docs/evals#x'
    );
  });
});
