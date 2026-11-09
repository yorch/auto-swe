// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OnboardingCard } from './OnboardingCard';

afterEach(cleanup);

describe('OnboardingCard', () => {
  it('starts open and folds its body away and back', () => {
    render(
      <OnboardingCard
        status={<span>1 of 3 done</span>}
        subtitle="Two left"
        title="Finish setting up"
      >
        <p>step list</p>
      </OnboardingCard>
    );
    expect(screen.getByRole('heading', { name: 'Finish setting up' })).toBeTruthy();
    expect(screen.getByText('1 of 3 done')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Collapse Finish setting up' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('step list').parentElement?.hidden).toBe(false);

    fireEvent.click(toggle);
    const expand = screen.getByRole('button', { name: 'Expand Finish setting up' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('step list').parentElement?.hidden).toBe(true);

    fireEvent.click(expand);
    expect(screen.getByText('step list').parentElement?.hidden).toBe(false);
  });
});
