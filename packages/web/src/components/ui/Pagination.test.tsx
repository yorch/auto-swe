// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from './Pagination';

describe('Pagination', () => {
  const base = { rangeEnd: 25, rangeStart: 1, total: 60 };

  it('is a labelled nav whose buttons call back and respect has-prev/has-next', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    render(<Pagination {...base} hasNext hasPrev={false} onNext={onNext} onPrev={onPrev} />);
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeTruthy();
    expect(screen.getByText('1–25 of 60')).toBeTruthy();
    const prev = screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onNext).toHaveBeenCalledOnce();
    expect(onPrev).not.toHaveBeenCalled();
  });
});
