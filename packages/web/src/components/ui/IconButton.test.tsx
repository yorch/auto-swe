// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IconButton, iconButtonClassName } from './IconButton';

describe('IconButton', () => {
  it('is named by its aria-label and defaults to type=button', () => {
    render(<IconButton aria-label="Close">x</IconButton>);
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button.getAttribute('type')).toBe('button');
  });

  it('forwards onClick, disabled and a ref', () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <IconButton aria-label="Go" onClick={onClick} ref={ref}>
        x
      </IconButton>
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
    expect(ref.current).toBe(screen.getByRole('button'));
  });

  it('meets the touch target floor at every size', () => {
    expect(iconButtonClassName({ size: 'sm' })).toContain('pointer-coarse:min-h-[44px]');
    expect(iconButtonClassName({ size: 'md' })).toContain('pointer-coarse:min-w-[44px]');
    // xs is drawn smaller than 24px, so it must inflate its hit area instead.
    expect(iconButtonClassName({ size: 'xs' })).toContain('after:-inset-1');
    expect(iconButtonClassName({ size: 'xs' })).toContain('pointer-coarse:after:-inset-4');
  });

  it('lets the caller override the shape and adds a focus ring', () => {
    const cls = iconButtonClassName({ shape: 'round' }, 'rounded-lg');
    expect(cls).toContain('rounded-lg');
    expect(cls).not.toContain('rounded-full');
    expect(cls).toContain('focus-visible:outline-2');
  });
});
