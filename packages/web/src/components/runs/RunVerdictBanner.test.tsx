// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RunVerdictBanner } from './RunVerdictBanner';

afterEach(cleanup);

it('keeps one primary action while long phone outcome details are initially collapsed', () => {
  const jump = vi.fn();
  const detail = 'A long failure explanation. '.repeat(40);
  render(
    <RunVerdictBanner
      onJumpToFailure={jump}
      verdict={{
        detail,
        headline: 'Stopped at implementation',
        nextAction: { kind: 'jump-to-failure', label: 'Jump to failure' },
        tone: 'error',
      }}
    />
  );
  const summary = screen.getByText('Outcome details');
  expect(summary.closest('details')?.hasAttribute('open')).toBe(false);
  expect(summary.closest('details')?.textContent).toContain(detail);
  expect(screen.getAllByRole('button', { name: 'Jump to failure' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Jump to failure' }));
  expect(jump).toHaveBeenCalledOnce();
});
