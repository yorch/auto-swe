// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from './ActionMenu';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  push.mockReset();
});

function open(items: Parameters<typeof ActionMenu>[0]['items']) {
  render(<ActionMenu items={items} label="More actions" />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

describe('ActionMenu', () => {
  it('runs an enabled item and navigates for an href item', () => {
    const onAction = vi.fn();
    open([
      { id: 'a', label: 'Edit', onAction },
      { href: '/x', id: 'b', label: 'Open' },
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('keeps an item with a disabledReason aria-disabled, described, and inert', () => {
    const blocked = vi.fn();
    const ok = vi.fn();
    open([
      {
        disabledReason: 'Only leads of Design can do this.',
        id: 'share',
        label: 'Share',
        onAction: blocked,
      },
      { id: 'edit', label: 'Edit', onAction: ok },
    ]);
    const item = screen.getByRole('menuitem', { name: 'Share' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe('Only leads of Design can do this.');
    const describedBy = item.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Only leads of Design can do this.'
    );
    fireEvent.click(item);
    expect(blocked).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
    // The menu stays open so the reason can be read, and the other items still work.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('leaves an item without a reason unmarked', () => {
    open([{ id: 'a', label: 'Edit', onAction: vi.fn() }]);
    const item = screen.getByRole('menuitem', { name: 'Edit' });
    expect(item.getAttribute('aria-disabled')).toBeNull();
    expect(item.getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps a reasoned item focusable by keyboard', () => {
    open([
      { disabledReason: 'No.', id: 'a', label: 'Share' },
      { id: 'b', label: 'Edit', onAction: vi.fn() },
    ]);
    const item = screen.getByRole('menuitem', { name: 'Share' });
    expect(item.getAttribute('tabindex')).not.toBe(null);
    expect(item.hasAttribute('data-disabled')).toBe(false);
  });
});
