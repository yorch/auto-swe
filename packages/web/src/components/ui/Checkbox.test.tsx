// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('is named by its label without needing an id', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} label="Overdue only" onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Overdue only' });
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledOnce();
  });
});
