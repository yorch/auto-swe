// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { WorkScopeControl } from './WorkScopeControl';

afterEach(cleanup);

describe('work list scope', () => {
  it.each(['MINE', 'TEAM'] as const)('shares labels and controlled selection for %s', (value) => {
    const onChange = vi.fn();
    render(<WorkScopeControl label="Work scope" onChange={onChange} value={value} />);
    expect(screen.getByRole('group', { name: 'Work scope' })).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: value === 'MINE' ? 'Mine' : 'My team' })
        .getAttribute('aria-pressed')
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
    expect(onChange).toHaveBeenLastCalledWith('MINE');
    fireEvent.click(screen.getByRole('button', { name: 'My team' }));
    expect(onChange).toHaveBeenLastCalledWith('TEAM');
  });
  it('keeps scope at the trailing end after search, filters and extras', () => {
    const { container } = render(
      <Toolbar end={<WorkScopeControl label="Work scope" onChange={() => {}} value="TEAM" />}>
        <SearchInput label="Search work" onChange={() => {}} value="" />
        <select aria-label="Status">
          <option>All statuses</option>
        </select>
        <label>
          <input type="checkbox" />
          Include automated
        </label>
      </Toolbar>
    );
    expect(
      [...container.querySelectorAll('input, select, fieldset')].map((element) => element.tagName)
    ).toEqual(['INPUT', 'SELECT', 'INPUT', 'FIELDSET']);
    expect(
      screen.getByRole('group', { name: 'Work scope' }).parentElement?.classList.contains('ml-auto')
    ).toBe(true);
  });
});
