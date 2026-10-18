// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable, type DataTableColumn } from './DataTable';

interface Row {
  id: string;
  name: string;
  note: string;
  count: number;
}

const ROWS: Row[] = [
  { count: 3, id: 'a', name: 'Alpha', note: 'first' },
  { count: 5, id: 'b', name: 'Beta', note: 'second' },
];

const COLUMNS: DataTableColumn<Row>[] = [
  {
    cell: (r) => r.name,
    header: 'Name',
    id: 'name',
    primary: true,
    secondary: (r) => r.note,
    sortable: true,
  },
  { align: 'right', cell: (r) => r.count, header: 'Count', id: 'count', sortable: true },
];

afterEach(cleanup);

describe('DataTable', () => {
  it('renders a table with column headings and one row per record', () => {
    render(<DataTable columns={COLUMNS} getRowId={(r) => r.id} rows={ROWS} />);
    expect(screen.getByRole('columnheader', { name: 'Name' }).getAttribute('scope')).toBe('col');
    expect(screen.getByRole('columnheader', { name: 'Count' })).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('names the table with a screen-reader-only caption', () => {
    render(
      <DataTable
        caption="Things, newest first"
        columns={COLUMNS}
        getRowId={(r) => r.id}
        rows={ROWS}
      />
    );
    expect(screen.getByRole('table', { name: 'Things, newest first' })).toBeTruthy();
  });

  it('puts a real link in the primary cell when rows have an href', () => {
    render(
      <DataTable
        columns={COLUMNS}
        getRowId={(r) => r.id}
        rowHref={(r) => `/things/${r.id}`}
        rows={ROWS}
      />
    );
    expect(screen.getByRole('link', { name: 'Alpha' }).getAttribute('href')).toBe('/things/a');
    expect(screen.getByRole('link', { name: 'Beta' }).getAttribute('href')).toBe('/things/b');
  });

  it('follows the row link on a click elsewhere in the row, and leaves other controls alone', () => {
    const onOther = vi.fn();
    render(
      <DataTable
        actions={() => (
          <button onClick={onOther} type="button">
            More
          </button>
        )}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        rowHref={(r) => `/things/${r.id}`}
        rows={[ROWS[0] as Row]}
      />
    );
    const link = screen.getByRole('link', { name: 'Alpha' }) as HTMLAnchorElement;
    const click = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener('click', click);
    fireEvent.click(screen.getByText('first'));
    expect(click).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(onOther).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('does not follow the row after a text selection', () => {
    render(
      <DataTable
        columns={COLUMNS}
        getRowId={(r) => r.id}
        rowHref={(r) => `/things/${r.id}`}
        rows={[ROWS[0] as Row]}
      />
    );
    const link = screen.getByRole('link', { name: 'Alpha' });
    const click = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener('click', click);
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'first',
    } as unknown as Selection);
    fireEvent.click(screen.getByText('first'));
    selection.mockRestore();
    expect(click).not.toHaveBeenCalled();
  });

  it('keeps the row link a tab stop so the keyboard reaches it', () => {
    render(
      <DataTable
        columns={COLUMNS}
        getRowId={(r) => r.id}
        rowHref={(r) => `/things/${r.id}`}
        rows={ROWS}
      />
    );
    const link = screen.getByRole('link', { name: 'Alpha' });
    expect(link.getAttribute('tabindex')).not.toBe('-1');
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it('renders the empty node instead of a table when there are no rows', () => {
    render(
      <DataTable columns={COLUMNS} empty={<p>Nothing here</p>} getRowId={(r) => r.id} rows={[]} />
    );
    expect(screen.getByText('Nothing here')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('keeps the header and shows a skeleton while loading', () => {
    render(
      <DataTable
        columns={COLUMNS}
        empty={<p>Nothing here</p>}
        getRowId={(r) => r.id}
        isLoading
        loadingLabel="things"
        rows={[]}
      />
    );
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Loading things');
    expect(screen.queryByText('Nothing here')).toBeNull();
  });

  it('reveals actions on hover and focus by default, and always when asked', () => {
    const actions = () => <button type="button">Do it</button>;
    const { rerender } = render(
      <DataTable actions={actions} columns={COLUMNS} getRowId={(r) => r.id} rows={ROWS} />
    );
    const wrapper = () => screen.getAllByRole('button', { name: 'Do it' })[0]?.parentElement;
    expect(wrapper()?.className).toContain('opacity-0');
    expect(wrapper()?.className).toContain('group-hover:opacity-100');
    expect(wrapper()?.className).toContain('group-focus-within:opacity-100');
    expect(wrapper()?.className).toContain('[@media(hover:none)]:opacity-100');
    expect(screen.getAllByRole('row')[1]?.className).toContain('group');
    expect(screen.getAllByRole('button', { name: 'Do it' })[0]?.getAttribute('tabindex')).not.toBe(
      '-1'
    );
    rerender(
      <DataTable
        actions={actions}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        revealActions={false}
        rows={ROWS}
      />
    );
    expect(wrapper()?.className).not.toContain('opacity-0');
  });

  it('labels each non-primary cell for the stacked mobile layout', () => {
    render(
      <DataTable
        columns={[...COLUMNS, { cell: (r) => r.note, header: <i>x</i>, id: 'n', label: 'Note' }]}
        getRowId={(r) => r.id}
        rows={[ROWS[0] as Row]}
      />
    );
    const row = screen.getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByText('Count').className).toContain('max-sm:inline');
    expect(within(row).getByText('Note').className).toContain('max-sm:inline');
    // The primary cell is the card title and carries no caption.
    expect(within(row).queryByText('Name')).toBeNull();
  });

  it('reports aria-sort and sort clicks on sortable headings', () => {
    const onSortChange = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        getRowId={(r) => r.id}
        onSortChange={onSortChange}
        rows={ROWS}
        sort={{ columnId: 'count', direction: 'descending' }}
      />
    );
    expect(screen.getByRole('columnheader', { name: 'Count' }).getAttribute('aria-sort')).toBe(
      'descending'
    );
    expect(screen.getByRole('columnheader', { name: 'Name' }).getAttribute('aria-sort')).toBe(
      'none'
    );
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(onSortChange).toHaveBeenCalledWith('name');
  });

  it('uses tighter cell padding in compact density', () => {
    const { rerender } = render(<DataTable columns={COLUMNS} getRowId={(r) => r.id} rows={ROWS} />);
    expect(screen.getByText('5').closest('td')?.className).toContain('py-3');
    rerender(<DataTable columns={COLUMNS} density="compact" getRowId={(r) => r.id} rows={ROWS} />);
    expect(screen.getByText('5').closest('td')?.className).toContain('py-2');
  });
});
