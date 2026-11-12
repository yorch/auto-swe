// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LaunchCardHeader } from './LaunchSteps';

describe('launch stages', () => {
  it.each(['details', 'review'] as const)('marks %s without a second set of numbers', (stage) => {
    render(<LaunchCardHeader stage={stage} title="Task" />);
    expect(screen.getByLabelText('Launch progress').textContent).not.toMatch(/[12]/);
    expect(
      screen.getByText(stage === 'details' ? 'Details' : 'Review').getAttribute('aria-current')
    ).toBe('step');
  });
});
