// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('defaults to type="button" so it does not accidentally submit forms', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('respects an explicit type override', () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
  });
});
