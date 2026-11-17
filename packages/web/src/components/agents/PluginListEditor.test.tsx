// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PluginListEditor } from './PluginListEditor';

const OPTIONS = [
  { name: 'a-kit', status: 'OK' as const },
  { name: 'b-kit', status: 'OK' as const },
  { name: 'old-kit', status: 'DISABLED' as const },
];

describe('PluginListEditor', () => {
  it('reorders and removes', () => {
    const onChange = vi.fn();
    render(<PluginListEditor onChange={onChange} options={OPTIONS} value={['a-kit', 'b-kit']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move b-kit up' }));
    expect(onChange).toHaveBeenLastCalledWith(['b-kit', 'a-kit']);
    fireEvent.click(screen.getByRole('button', { name: 'Move a-kit down' }));
    expect(onChange).toHaveBeenLastCalledWith(['b-kit', 'a-kit']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a-kit' }));
    expect(onChange).toHaveBeenLastCalledWith(['b-kit']);
  });

  it('disables the ends of the list', () => {
    render(<PluginListEditor onChange={vi.fn()} options={OPTIONS} value={['a-kit', 'b-kit']} />);
    expect(
      (screen.getByRole('button', { name: 'Move a-kit up' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Move b-kit down' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('adds a plugin that is not on the list yet, never a disabled one or a repeat', () => {
    const onChange = vi.fn();
    render(<PluginListEditor onChange={onChange} options={OPTIONS} value={['a-kit']} />);
    const box = screen.getByRole('combobox', { name: 'Add plugin' });
    act(() => box.focus());
    fireEvent.change(box, { target: { value: 'k' } });
    expect(screen.queryByRole('option', { name: 'old-kit' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'a-kit' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'b-kit' }));
    expect(onChange).toHaveBeenCalledWith(['a-kit', 'b-kit']);
  });

  it('keeps an already-bound disabled plugin visible and flagged', () => {
    render(<PluginListEditor onChange={vi.fn()} options={OPTIONS} value={['old-kit']} />);
    expect(screen.getByText('old-kit')).toBeTruthy();
    expect(screen.getByText('disabled')).toBeTruthy();
  });

  it('flags a bound plugin the caller is not offered', () => {
    render(<PluginListEditor onChange={vi.fn()} options={[]} value={['elsewhere']} />);
    expect(screen.getByText('not offered to you')).toBeTruthy();
  });

  it('is a read-only line without options, and nothing when empty', () => {
    const { container, rerender } = render(
      <PluginListEditor onChange={vi.fn()} value={['a-kit', 'b-kit']} />
    );
    expect(screen.getByText('a-kit, b-kit')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<PluginListEditor onChange={vi.fn()} value={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
