// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HelpButton } from '@/components/help/HelpPanel';
import { DocLink, docHref } from './DocLink';
import { PageHeader } from './PageHeader';

vi.mock('next/navigation', () => ({ usePathname: () => '/runs' }));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

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

  it('keeps the docs link out of the page, in the Help panel', () => {
    render(<PageHeader learnMore={{ anchor: 'x', slug: 'evals' }} subtitle="sub" title="Evals" />);
    expect(screen.queryByRole('link', { name: 'Learn more' })).toBeNull();
  });

  it('puts the docs link and the extra help in the Help panel', () => {
    render(
      <>
        <HelpButton />
        <PageHeader
          help={<p>Days are UTC.</p>}
          learnMore={{ anchor: 'x', slug: 'evals' }}
          subtitle="sub"
          title="Evals"
        />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
    expect(
      screen.getByRole('link', { hidden: true, name: 'Learn more' }).getAttribute('href')
    ).toBe('/docs/evals#x');
    expect(screen.getByText('Days are UTC.')).toBeTruthy();
  });
});
