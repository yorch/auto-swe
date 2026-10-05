// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToggleSwitch } from './ToggleSwitch';

afterEach(cleanup);

describe('ToggleSwitch', () => {
  it('takes its accessible name from ariaLabel when there is no visible label', () => {
    render(<ToggleSwitch ariaLabel="Active: Lint rules" checked onChange={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Active: Lint rules' })).toBeTruthy();
  });

  it('takes its accessible name from the visible label', () => {
    render(<ToggleSwitch checked={false} label="Show retired" onChange={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Show retired' })).toBeTruthy();
  });
});
