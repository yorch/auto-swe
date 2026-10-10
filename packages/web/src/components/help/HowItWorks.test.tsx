// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HowItWorks } from './HowItWorks';

afterEach(cleanup);

describe('HowItWorks', () => {
  it('is a closed disclosure by default and open on request', () => {
    const { container, rerender } = render(<HowItWorks />);
    expect(screen.getByText('How auto-swe works')).toBeTruthy();
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
    rerender(<HowItWorks defaultOpen />);
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(true);
  });

  it('lists the five lifecycle steps in order', () => {
    render(<HowItWorks defaultOpen />);
    const steps = screen.getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent);
    expect(steps).toEqual(['Request', 'Run', 'Gate', 'Pull request', 'You merge']);
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });

  it('says plainly that auto-swe never merges', () => {
    render(<HowItWorks defaultOpen />);
    expect(screen.getAllByText(/merges a pull request/)).toHaveLength(1);
    expect(screen.getByText(/No built-in step or template merges a pull request/)).toBeTruthy();
    expect(screen.queryByText(/draft/i)).toBeNull();
  });

  it('links to the concepts doc and explains request, run and gate', () => {
    render(<HowItWorks defaultOpen />);
    expect(screen.getByRole('link', { name: 'Read the concepts guide' }).getAttribute('href')).toBe(
      '/docs/concepts'
    );
    for (const name of ['What is a request?', 'What is a run?', 'What is a gate?']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });
});
