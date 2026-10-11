// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SampleTaskButton } from './SampleTaskButton';

afterEach(cleanup);

describe('SampleTaskButton', () => {
  it('fills once on click and describes the button with a caption that is not a live region', () => {
    const onFill = vi.fn();
    render(<SampleTaskButton blocked={false} caption="Fills the prompt." onFill={onFill} />);
    const button = screen.getByRole('button', { name: 'Try a sample task' });
    fireEvent.click(button);
    expect(onFill).toHaveBeenCalledTimes(1);
    const caption = screen.getByText('Fills the prompt.');
    expect(button.getAttribute('aria-describedby')).toBe(caption.id);
    expect(caption.getAttribute('role')).toBeNull();
  });

  it('is disabled while blocked and says why', () => {
    const onFill = vi.fn();
    render(<SampleTaskButton blocked caption="Fills the prompt." onFill={onFill} />);
    const button = screen.getByRole('button', { name: 'Try a sample task' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Clear the fields you have filled in/)).toBeTruthy();
  });

  it('forgets a previous fill once the fields are cleared again', () => {
    const { rerender } = render(
      <SampleTaskButton blocked={false} caption="Fills the prompt." onFill={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try a sample task' }));
    rerender(<SampleTaskButton blocked caption="Fills the prompt." onFill={vi.fn()} />);
    expect(screen.getByText(/Sample filled in/)).toBeTruthy();
    rerender(<SampleTaskButton blocked={false} caption="Fills the prompt." onFill={vi.fn()} />);
    expect(screen.getByText('Fills the prompt.')).toBeTruthy();
    rerender(<SampleTaskButton blocked caption="Fills the prompt." onFill={vi.fn()} />);
    expect(screen.getByText(/Clear the fields you have filled in/)).toBeTruthy();
    expect(screen.queryByText(/Sample filled in/)).toBeNull();
  });
});
