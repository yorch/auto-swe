// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunVerdictBanner } from './RunVerdictBanner';

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

it('keeps long phone explanations outside the verdict layout and restores focus on dismiss', () => {
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
  const trigger = screen.getByRole('button', { name: 'Outcome details' });
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
  expect(screen.queryByRole('dialog')).toBeNull();
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Outcome details' });
  expect(within(dialog).getByRole('region', { name: 'Outcome explanation' }).textContent).toBe(
    detail
  );
  expect(document.activeElement).toBe(
    within(dialog).getByRole('region', { name: 'Outcome explanation' })
  );
  expect(trigger.closest('[data-tour="run:verdict"]')?.contains(dialog)).toBe(false);
  expect(within(dialog).getByText('Stopped at implementation')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  const reopened = screen.getByRole('dialog', { name: 'Outcome details' });
  fireEvent.mouseDown(reopened);
  fireEvent.click(reopened);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(screen.getAllByRole('button', { name: 'Jump to failure' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Jump to failure' }));
  expect(jump).toHaveBeenCalledOnce();
});
