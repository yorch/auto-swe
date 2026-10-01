// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Slider } from './Slider';

describe('Slider', () => {
  it('is labelled, shows a formatted readout, and reports numeric changes', () => {
    const onChange = vi.fn();
    render(
      <Slider
        formatValue={(v) => `${v}%`}
        hint="v1 gets 90%"
        label="Traffic split"
        max={50}
        min={1}
        onChange={onChange}
        value={10}
      />
    );
    const slider = screen.getByLabelText('Traffic split') as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.getAttribute('aria-describedby')).toBe('traffic-split-hint');
    expect(slider.getAttribute('aria-valuetext')).toBe('10%');
    expect(screen.getByText('10%')).toBeTruthy();
    fireEvent.change(slider, { target: { value: '25' } });
    expect(onChange).toHaveBeenCalledWith(25);
  });
});
