// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useThemeStore } from '@/stores/themeStore';
import { ThemeToggle } from './ThemeToggle';

beforeEach(() => useThemeStore.getState().setPreference('dark'));
afterEach(cleanup);

describe('ThemeToggle', () => {
  it('names the current theme and the one a click moves to', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: 'Theme: Dark. Switch to Light' })).toBeTruthy();
  });

  it('cycles dark → light → system → dark and paints each choice', () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button');

    fireEvent.click(button);
    expect(useThemeStore.getState().preference).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(button.getAttribute('aria-label')).toBe('Theme: Light. Switch to System');

    fireEvent.click(button);
    expect(useThemeStore.getState().preference).toBe('system');

    fireEvent.click(button);
    expect(useThemeStore.getState().preference).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
