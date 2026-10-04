// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { dateRangePatch, parseDateRange, rangeBounds } from '@/lib/dateRange';
import { DateRangeControl } from './DateRangeControl';

describe('DateRangeControl', () => {
  it('reports a preset', () => {
    const onChange = vi.fn();
    render(<DateRangeControl onChange={onChange} value={{ days: 30, kind: 'preset' }} />);
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    expect(onChange).toHaveBeenCalledWith({ days: 7, kind: 'preset' });
  });

  it('applies a custom span only when it is valid, and labels it UTC', () => {
    const onChange = vi.fn();
    render(<DateRangeControl onChange={onChange} value={{ days: 30, kind: 'preset' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByText('Dates are UTC')).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('From date (UTC)'), { target: { value: '2026-01-02' } });
    fireEvent.change(screen.getByLabelText('To date (UTC)'), { target: { value: '2026-01-01' } });
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('To date (UTC)'), { target: { value: '2026-01-05' } });
    fireEvent.click(apply);
    expect(onChange).toHaveBeenCalledWith({ from: '2026-01-02', kind: 'custom', to: '2026-01-05' });
  });

  it('hides the custom option when the source cannot serve it', () => {
    render(
      <DateRangeControl
        allowCustom={false}
        onChange={() => {}}
        value={{ days: 7, kind: 'preset' }}
      />
    );
    expect(screen.queryByRole('button', { name: 'Custom' })).toBeNull();
  });
});

describe('dateRange helpers', () => {
  it('parses the URL and falls back on junk', () => {
    expect(parseDateRange(new URLSearchParams('range=90'))).toEqual({ days: 90, kind: 'preset' });
    expect(parseDateRange(new URLSearchParams('range=12'))).toEqual({ days: 30, kind: 'preset' });
    expect(
      parseDateRange(new URLSearchParams('range=custom&from=2026-02-01&to=2026-02-03'))
    ).toEqual({
      from: '2026-02-01',
      kind: 'custom',
      to: '2026-02-03',
    });
    expect(
      parseDateRange(new URLSearchParams('range=custom&from=2026-02-30&to=2026-03-03'))
    ).toEqual({
      days: 30,
      kind: 'preset',
    });
  });

  it('writes the default as absent keys and bounds a custom span to the end of its last day', () => {
    expect(dateRangePatch({ days: 30, kind: 'preset' })).toEqual({
      from: null,
      range: null,
      to: null,
    });
    expect(rangeBounds({ from: '2026-02-01', kind: 'custom', to: '2026-02-03' })).toEqual({
      since: '2026-02-01T00:00:00.000Z',
      until: '2026-02-04T00:00:00.000Z',
    });
  });
});

describe('DateRangeControl all time', () => {
  it('reports null for "All"', () => {
    const onChange = vi.fn();
    render(<DateRangeControl allowAll onChange={onChange} value={{ days: 7, kind: 'preset' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
