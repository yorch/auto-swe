// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HowItWorks } from './HowItWorks';

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));

afterEach(cleanup);

describe('HowItWorks', () => {
  it('is help content, not a disclosure on the page', () => {
    const { container } = render(<HowItWorks />);
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByTestId('page-help')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'How auto-swe works' })).toBeTruthy();
  });

  it('lists the five lifecycle steps in order', () => {
    render(<HowItWorks />);
    const steps = screen.getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent);
    expect(steps).toEqual(['Request', 'Run', 'Gate', 'Pull request', 'You merge']);
  });

  it('says plainly that auto-swe never merges', () => {
    render(<HowItWorks />);
    expect(screen.getAllByText(/merges a pull request/)).toHaveLength(1);
    expect(screen.getByText(/No built-in step or template merges a pull request/)).toBeTruthy();
    expect(screen.queryByText(/draft/i)).toBeNull();
  });

  it('links to the concepts doc and explains request, run and gate', () => {
    render(<HowItWorks />);
    expect(screen.getByRole('link', { name: 'Read the concepts guide' }).getAttribute('href')).toBe(
      '/docs/concepts'
    );
    for (const name of ['What is a request?', 'What is a run?', 'What is a gate?']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });
});
