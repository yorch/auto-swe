// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

const OPTIONS = [
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
] as const;

describe('SegmentedControl', () => {
  it('names the group and marks only the selected option pressed', () => {
    render(
      <SegmentedControl ariaLabel="Range" onChange={() => {}} options={[...OPTIONS]} value="30d" />
    );
    expect(screen.getByRole('group', { name: 'Range' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '30d' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '7d' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the clicked value', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl ariaLabel="Range" onChange={onChange} options={[...OPTIONS]} value="30d" />
    );
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    expect(onChange).toHaveBeenCalledWith('7d');
  });
});
