// @vitest-environment jsdom

import { cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNSAVED_CHANGES_PROMPT, useUnsavedChangesGuard } from './useUnsavedChangesGuard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function click(el: Element) {
  const event = new MouseEvent('click', { bubbles: true, button: 0, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

describe('useUnsavedChangesGuard', () => {
  it('asks before an in-app link is followed and cancels it on no', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = render(<a href="/elsewhere">go</a>);
    renderHook(() => useUnsavedChangesGuard(true));

    const event = click(container.querySelector('a') as Element);
    expect(confirm).toHaveBeenCalledWith(UNSAVED_CHANGES_PROMPT);
    expect(event.defaultPrevented).toBe(true);
  });

  it('lets the link through when confirmed, and asks only once for two dirty forms', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(<a href="/elsewhere">go</a>);
    renderHook(() => useUnsavedChangesGuard(true));
    renderHook(() => useUnsavedChangesGuard(true));

    const event = click(container.querySelector('a') as Element);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does nothing while the form is clean', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = render(<a href="/elsewhere">go</a>);
    renderHook(() => useUnsavedChangesGuard(false));

    click(container.querySelector('a') as Element);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('registers a beforeunload prompt while dirty and removes it after', () => {
    const { unmount } = renderHook(() => useUnsavedChangesGuard(true));
    const during = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);

    unmount();
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
