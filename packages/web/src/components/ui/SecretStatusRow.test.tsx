// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SecretStatusRow } from './SecretStatusRow';

describe('SecretStatusRow', () => {
  it('shows the message alone when there is no action', () => {
    render(<SecretStatusRow>Not set</SecretStatusRow>);
    expect(screen.getByText('Not set')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('runs its action and reports a staged toggle as pressed', () => {
    const onClick = vi.fn();
    render(
      <SecretStatusRow action={{ label: 'Keep stored token', onClick, pressed: true }}>
        Will be cleared on save.
      </SecretStatusRow>
    );
    const button = screen.getByRole('button', { name: 'Keep stored token' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
