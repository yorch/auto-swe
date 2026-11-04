// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, buttonClassName } from './Button';

describe('Button', () => {
  it('defaults to type="button" so it does not accidentally submit forms', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('respects an explicit type override', () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
  });

  it('paints primary as solid accent-500 with white text — no gradient, no glow', () => {
    const primary = buttonClassName('primary', 'md');
    expect(primary).toContain('bg-accent-500');
    expect(primary).toContain('text-white');
    // accent-400 is only 3.9:1 behind white text; 500 and its darker hover clear 4.5:1.
    expect(primary).not.toMatch(/bg-accent-400|gradient|brightness|shadow/);
  });

  it('floors every button at 44px on a coarse pointer', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      expect(buttonClassName('secondary', size)).toContain('pointer-coarse:min-h-11');
    }
  });

  it('has a solid danger variant as heavy as primary', () => {
    const danger = buttonClassName('danger-solid', 'md');
    expect(danger).toContain('bg-danger-600');
    expect(danger).toContain('text-white');
  });
});
