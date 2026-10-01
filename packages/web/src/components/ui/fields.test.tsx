// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Checkbox } from './Checkbox';
import { Input } from './Input';
import { Select } from './Select';
import { Textarea } from './Textarea';

describe('required field marker', () => {
  it.each([
    ['Input', <Input key="i" label="Name" required />],
    ['Textarea', <Textarea key="t" label="Name" required />],
    [
      'Select',
      <Select
        key="s"
        label="Name"
        onChange={() => {}}
        options={[{ label: 'a', value: 'a' }]}
        required
        value="a"
      />,
    ],
  ])('%s shows an aria-hidden * and keeps native required', (_n, el) => {
    const { container } = render(el);
    // Select's label is a span, not a <label>, so match the marker by its text.
    const mark = Array.from(container.querySelectorAll('[aria-hidden="true"]')).find(
      (n) => n.textContent?.trim() === '*'
    );
    expect(mark).toBeTruthy();
    // The marker is hidden from the accessible name; native `required` carries the meaning.
    // Select keeps `required` on the hidden native select React Aria renders for forms.
    const control = (
      _n === 'Select'
        ? container.querySelector('select')
        : screen.getByRole('textbox', { name: 'Name' })
    ) as HTMLInputElement;
    expect(control.required).toBe(true);
  });

  it('shows no marker when not required', () => {
    const { container } = render(<Input label="Name" />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('Checkbox marks the label without making the box natively required', () => {
    const { container } = render(<Checkbox label="Agree" marked />);
    expect(container.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('*');
    expect((screen.getByRole('checkbox') as HTMLInputElement).required).toBe(false);
  });
});
