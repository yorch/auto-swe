// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LayoutToggle } from './LayoutToggle';

describe('LayoutToggle', () => {
  it('marks A button as active when value is A', () => {
    render(<LayoutToggle onChange={vi.fn()} value="A" />);
    expect(screen.getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Transcript' }).getAttribute('aria-pressed')).toBe(
      'false'
    );
  });

  it('marks B button as active when value is B', () => {
    render(<LayoutToggle onChange={vi.fn()} value="B" />);
    expect(screen.getByRole('button', { name: 'Transcript' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(screen.getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe(
      'false'
    );
  });

  it('calls onChange with "B" when B button is clicked', () => {
    const onChange = vi.fn();
    render(<LayoutToggle onChange={onChange} value="A" />);
    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    expect(onChange).toHaveBeenCalledWith('B');
  });

  it('calls onChange with "A" when A button is clicked', () => {
    const onChange = vi.fn();
    render(<LayoutToggle onChange={onChange} value="C" />);
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));
    expect(onChange).toHaveBeenCalledWith('A');
  });
});
