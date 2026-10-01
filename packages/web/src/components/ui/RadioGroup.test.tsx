// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RadioGroup } from './RadioGroup';

const OPTIONS = [
  { description: 'In the database', label: 'Inline', value: 'inline' },
  { label: 'S3', value: 's3' },
] as const;

describe('RadioGroup', () => {
  it('is a group named by its legend, with one shared name and the selected option checked', () => {
    render(
      <RadioGroup
        legend="Backend"
        name="backend"
        onChange={() => {}}
        options={[...OPTIONS]}
        value="s3"
      />
    );
    expect(screen.getByRole('group', { name: 'Backend' })).toBeTruthy();
    const inline = screen.getByRole('radio', { name: /Inline/ }) as HTMLInputElement;
    const s3 = screen.getByRole('radio', { name: 'S3' }) as HTMLInputElement;
    expect(inline.name).toBe('backend');
    expect(s3.name).toBe('backend');
    expect(s3.checked).toBe(true);
    expect(inline.checked).toBe(false);
    expect(screen.getByText('In the database')).toBeTruthy();
  });

  it('reports the chosen value', () => {
    const onChange = vi.fn();
    render(
      <RadioGroup
        legend="Backend"
        name="backend"
        onChange={onChange}
        options={[...OPTIONS]}
        value="s3"
      />
    );
    fireEvent.click(screen.getByRole('radio', { name: /Inline/ }));
    expect(onChange).toHaveBeenCalledWith('inline');
  });
});
