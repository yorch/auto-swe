// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Table, THead, Th } from './Table';

describe('Th sorting', () => {
  it('sets aria-sort per column, hides the arrow, and reports clicks', () => {
    const onSort = vi.fn();
    render(
      <Table>
        <THead>
          <Th>Name</Th>
          <Th onSort={onSort} sort="descending">
            Runs
          </Th>
          <Th onSort={() => {}} sort="ascending">
            Cost
          </Th>
          <Th onSort={() => {}} sort="none">
            Rate
          </Th>
        </THead>
      </Table>
    );
    const header = (name: string) => screen.getByRole('columnheader', { name });
    expect(header('Name').getAttribute('aria-sort')).toBeNull();
    expect(header('Runs').getAttribute('aria-sort')).toBe('descending');
    expect(header('Cost').getAttribute('aria-sort')).toBe('ascending');
    expect(header('Rate').getAttribute('aria-sort')).toBe('none');
    // The arrow is aria-hidden, so the button's accessible name is the bare label.
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
    expect(onSort).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Name' })).toBeNull();
  });
});
