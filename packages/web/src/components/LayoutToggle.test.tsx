// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LayoutToggle } from './LayoutToggle';

describe('LayoutToggle', () => {
  it('marks split button as active when value is split', () => {
    render(<LayoutToggle onChange={vi.fn()} value="split" />);
    expect(screen.getByLabelText('Split panel layout').className).toContain('bg-ink-500');
    expect(screen.getByLabelText('Inline list layout').className).not.toContain('bg-ink-500');
  });

  it('marks inline button as active when value is inline', () => {
    render(<LayoutToggle onChange={vi.fn()} value="inline" />);
    expect(screen.getByLabelText('Inline list layout').className).toContain('bg-ink-500');
    expect(screen.getByLabelText('Split panel layout').className).not.toContain('bg-ink-500');
  });

  it('calls onChange with "inline" when inline button is clicked', () => {
    const onChange = vi.fn();
    render(<LayoutToggle onChange={onChange} value="split" />);
    fireEvent.click(screen.getByLabelText('Inline list layout'));
    expect(onChange).toHaveBeenCalledWith('inline');
  });

  it('calls onChange with "split" when split button is clicked', () => {
    const onChange = vi.fn();
    render(<LayoutToggle onChange={onChange} value="inline" />);
    fireEvent.click(screen.getByLabelText('Split panel layout'));
    expect(onChange).toHaveBeenCalledWith('split');
  });
});
