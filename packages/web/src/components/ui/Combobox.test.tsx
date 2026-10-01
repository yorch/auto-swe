// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Combobox } from './Combobox';

const USERS = [
  { label: 'ada@example.com · ADMIN', value: 'u1' },
  { label: 'grace@example.com · LEAD', value: 'u2' },
  { label: 'linus@example.com · ENGINEER', value: 'u3' },
];

/** Focus the field, then type — React Aria opens the list only while the input is focused. */
function type(input: HTMLElement, text: string) {
  act(() => input.focus());
  fireEvent.change(input, { target: { value: text } });
}

describe('Combobox', () => {
  it('is named by its label and filters options by typed text', () => {
    render(<Combobox label="User" onChange={() => {}} options={USERS} value="" />);
    const input = screen.getByRole('combobox', { name: /user/i });
    type(input, 'grace');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('grace@example.com');
  });

  it('reports the picked value', () => {
    const onChange = vi.fn();
    render(<Combobox label="User" onChange={onChange} options={USERS} value="" />);
    type(screen.getByRole('combobox', { name: /user/i }), 'linus');
    fireEvent.click(screen.getByRole('option', { name: /linus/ }));
    expect(onChange).toHaveBeenCalledWith('u3');
  });

  it('says so when nothing matches, instead of closing silently', () => {
    render(
      <Combobox
        emptyMessage="No users match"
        label="User"
        onChange={() => {}}
        options={USERS}
        value=""
      />
    );
    type(screen.getByRole('combobox', { name: /user/i }), 'zzz');
    expect(screen.getByText('No users match')).toBeTruthy();
  });

  it('shows the selected option as the input text', () => {
    render(<Combobox label="User" onChange={() => {}} options={USERS} value="u2" />);
    const input = screen.getByRole('combobox', { name: /user/i }) as HTMLInputElement;
    expect(input.value).toBe('grace@example.com · LEAD');
  });

  it('picks up options that arrive after mount', () => {
    const { rerender } = render(
      <Combobox label="User" onChange={() => {}} options={[]} value="" />
    );
    rerender(<Combobox label="User" onChange={() => {}} options={USERS} value="" />);
    type(screen.getByRole('combobox', { name: /user/i }), 'ada');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('does not pop the list open on focus alone — tabbing through stays quiet', () => {
    render(<Combobox label="User" onChange={() => {}} options={USERS} value="" />);
    act(() => screen.getByRole('combobox', { name: /user/i }).focus());
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('marks its box while the input has focus, so the focus ring shows', () => {
    render(<Combobox label="User" onChange={() => {}} options={USERS} value="" />);
    const input = screen.getByRole('combobox', { name: /user/i });
    act(() => input.focus());
    expect(input.closest('[data-focus-within]')).toBeTruthy();
  });

  it('never blocks submit because it is showing an error', () => {
    const { container } = render(
      <form>
        <Combobox
          error="Pick someone else"
          label="User"
          name="user"
          onChange={() => {}}
          options={USERS}
          required
          value="u1"
        />
      </form>
    );
    expect((container.querySelector('form') as HTMLFormElement).checkValidity()).toBe(true);
  });

  describe('allowsCustomValue', () => {
    const MODELS = [
      { label: 'anthropic/claude-opus-5-5', value: 'anthropic/claude-opus-5-5' },
      { label: 'openai/gpt-5.5', value: 'openai/gpt-5.5' },
    ];

    /** Holds the value the way a caller does — the input is controlled by it. */
    function ModelPicker({ onChange }: { onChange: (v: string) => void }) {
      const [value, setValue] = useState('');
      return (
        <Combobox
          allowsCustomValue
          label="Model"
          onChange={(v) => {
            setValue(v);
            onChange(v);
          }}
          options={MODELS}
          value={value}
        />
      );
    }

    it('reports typed text that matches no option as the value', () => {
      const onChange = vi.fn();
      render(<ModelPicker onChange={onChange} />);
      type(screen.getByRole('combobox', { name: /model/i }), 'ollama/llama-4');
      expect(onChange).toHaveBeenLastCalledWith('ollama/llama-4');
    });

    it('still reports a picked option, and still filters by typed text', () => {
      const onChange = vi.fn();
      render(<ModelPicker onChange={onChange} />);
      type(screen.getByRole('combobox', { name: /model/i }), 'gpt');
      expect(screen.getAllByRole('option')).toHaveLength(1);
      fireEvent.click(screen.getByRole('option', { name: /gpt-5\.5/ }));
      expect(onChange).toHaveBeenLastCalledWith('openai/gpt-5.5');
    });

    it('shows a value no option has, instead of an empty box', () => {
      render(
        <Combobox
          allowsCustomValue
          label="Model"
          onChange={() => {}}
          options={MODELS}
          value="vllm/qwen-3"
        />
      );
      expect(screen.getByRole('combobox', { name: /model/i })).toHaveProperty(
        'value',
        'vllm/qwen-3'
      );
    });
  });
});
