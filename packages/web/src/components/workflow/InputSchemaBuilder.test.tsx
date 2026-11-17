// @vitest-environment jsdom
import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputSchemaBuilder } from './InputSchemaBuilder';

afterEach(cleanup);

const stringEnum: InputSchema = {
  properties: { color: { enum: ['a', 'b'], type: 'string' } },
  type: 'object',
};

describe('InputSchemaBuilder', () => {
  it('drops the enum when a string field becomes a number', () => {
    const onChange = vi.fn();
    render(<InputSchemaBuilder onChange={onChange} value={stringEnum} />);
    fireEvent.click(screen.getByRole('button', { name: /type/i }));
    fireEvent.click(screen.getByRole('option', { name: 'Number' }));
    expect(onChange).toHaveBeenLastCalledWith({
      properties: { color: { type: 'number' } },
      type: 'object',
    });
  });

  it('reports a blank key and marks the input invalid', () => {
    const onProblem = vi.fn();
    render(<InputSchemaBuilder onChange={vi.fn()} onProblemChange={onProblem} value={null} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add field' })[0] as HTMLElement);
    const key = screen.getByLabelText('Field key');
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(key.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Key required')).toBeTruthy();
    expect(onProblem).toHaveBeenLastCalledWith('Every field needs a key.');
  });

  it('keeps a non-string enum when another field is edited', () => {
    const onChange = vi.fn();
    const numeric: InputSchema = {
      properties: {
        n: { enum: [1, 2, 3], type: 'number' },
        s: { type: 'string' },
      },
      type: 'object',
    };
    render(<InputSchemaBuilder onChange={onChange} value={numeric} />);
    fireEvent.change(screen.getAllByLabelText('Description')[1] as HTMLElement, {
      target: { value: 'Label' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      properties: {
        n: { enum: [1, 2, 3], type: 'number' },
        s: { description: 'Label', type: 'string' },
      },
      type: 'object',
    });
  });

  it('reports a duplicate key', () => {
    const onProblem = vi.fn();
    const dupes: InputSchema = {
      properties: { a: { type: 'string' } },
      type: 'object',
    };
    render(<InputSchemaBuilder onChange={vi.fn()} onProblemChange={onProblem} value={dupes} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add field' })[0] as HTMLElement);
    fireEvent.change(screen.getAllByLabelText('Field key')[1] as HTMLElement, {
      target: { value: 'a' },
    });
    expect(onProblem).toHaveBeenLastCalledWith(expect.stringContaining('unique'));
  });
});
