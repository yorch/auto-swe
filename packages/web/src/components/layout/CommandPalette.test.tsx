// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThemeStore } from '@/stores/themeStore';
import { CommandPalette } from './CommandPalette';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/hooks/useVisibleNav', () => ({
  useVisibleNavGroups: () => [
    { items: [{ href: '/runs', icon: 'runs', label: 'Runs' }], label: 'Work' },
  ],
}));

beforeEach(() => {
  push.mockClear();
  useThemeStore.getState().setPreference('dark');
});
afterEach(cleanup);

async function openPalette() {
  const onOpenChange = vi.fn();
  await act(async () => {
    render(<CommandPalette onOpenChange={onOpenChange} open />);
  });
  return onOpenChange;
}

describe('CommandPalette', () => {
  it('runs a theme command in place instead of navigating', async () => {
    const onOpenChange = await openPalette();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'theme' } });
    fireEvent.click(screen.getByRole('button', { name: /Theme: light/ }));

    expect(useThemeStore.getState().preference).toBe('light');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('offers all three theme choices', async () => {
    await openPalette();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'theme' } });
    for (const name of [/Theme: dark/, /Theme: light/, /Theme: follow system/]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('still opens a page on Enter', async () => {
    await openPalette();
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'runs' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/runs');
  });
});
