'use client';

import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';
import { SkeletonRows } from '@/components/ui/LoadingState';
import {
  type SortDirection,
  Table,
  TableStatusRow,
  Td,
  THead,
  Th,
  TRow,
} from '@/components/ui/Table';
import { cn, FOCUS_RING, ROW_ACTION } from '@/lib/utils';

export type DataTableDensity = 'comfortable' | 'compact';
export type DataTableAlign = 'left' | 'right' | 'center';

export interface DataTableColumn<Row> {
  /** Stable key; also what `onSortChange` reports. */
  id: string;
  /** The column heading. Use a string where possible: it doubles as the stacked label. */
  header: ReactNode;
  /** The cell's content. For the primary column, the text of the row link. */
  cell: (row: Row) => ReactNode;
  align?: DataTableAlign;
  /** Tailwind width/sizing classes for the cell, e.g. `sm:w-28`. */
  width?: string;
  /**
   * The row's title. With `rowHref` its `cell` becomes the row's link; without
   * one it renders as plain text. Below `sm` it is the card's title.
   */
  primary?: boolean;
  /** A muted line under the primary cell (ticket ID, progress, tags). */
  secondary?: (row: Row) => ReactNode;
  /** The caption beside the value when the table stacks below `sm`. Defaults to a string `header`. */
  label?: string;
  /** Makes the heading a sort button; needs `sort` and `onSortChange` on the table. */
  sortable?: boolean;
}

export interface DataTableSort {
  columnId: string;
  direction: Exclude<SortDirection, 'none'>;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  /** An accessible name for the table, read by screen readers and not shown. */
  caption?: string;
  getRowId: (row: Row) => string;
  /** Where the row opens. The primary cell links there and a click elsewhere on the row follows it. */
  rowHref?: (row: Row) => string;
  /** Whether following a row link scrolls to the top (Next's `scroll`). Default true. */
  rowScroll?: boolean;
  density?: DataTableDensity;
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode;
  /** Renders the header with `SkeletonRows` as the body. */
  isLoading?: boolean;
  /** What is loading, for the skeleton's announcement ("runs"). */
  loadingLabel?: string;
  sort?: DataTableSort | null;
  onSortChange?: (columnId: string) => void;
  /** A trailing cell of per-row controls. */
  actions?: (row: Row) => ReactNode;
  /** Whether `actions` hide until hover or focus within the row (always visible on touch). Default true. */
  revealActions?: boolean;
  /** Accessible name for the actions column heading. Default "Actions". */
  actionsLabel?: string;
  className?: string;
}

/** Elements inside a row whose own click must not also follow the row link. */
const INTERACTIVE =
  'a,button,input,select,textarea,label,summary,[role="button"],[role="menuitem"]';

const CELL_PADDING: Record<DataTableDensity, string> = {
  comfortable: 'px-4 py-3',
  compact: 'px-4 py-2',
};

/**
 * The link in a row's primary cell. `DataTable` renders it for you when you
 * pass `rowHref`; it is exported for the rare cell that needs a second one.
 */
export function TableLink({
  children,
  href,
  scroll,
  title,
}: {
  children: ReactNode;
  href: string;
  scroll?: boolean;
  title?: string;
}) {
  return (
    <Link
      className={cn(
        'line-clamp-2 break-words rounded-sm font-medium text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
        FOCUS_RING
      )}
      data-row-link=""
      href={href}
      scroll={scroll}
      title={title}
    >
      {children}
    </Link>
  );
}

function sortState(column: { id: string; sortable?: boolean }, sort?: DataTableSort | null) {
  if (!column.sortable) {
    return undefined;
  }
  return sort?.columnId === column.id ? sort.direction : 'none';
}

/**
 * A typed, column-driven list of one kind of record, built on `Table`. Every
 * list of runs, requests or templates uses it so the same work reads the same
 * way: status, title (with a secondary line), then the facts, then actions.
 *
 *   <DataTable
 *     columns={[
 *       { id: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
 *       { id: 'title', header: 'Title', primary: true, cell: (r) => r.title },
 *     ]}
 *     getRowId={(r) => r.id}
 *     rowHref={(r) => runHref(r.id)}
 *     rows={rows}
 *   />
 *
 * With `rowHref` the primary cell holds a real link (the keyboard and
 * screen-reader path) and a click anywhere else on the row follows it, unless
 * the click lands on another link or control, or ends a text selection.
 * Below `sm` the rows turn into cards that use each column's `label`.
 */
export function DataTable<Row>({
  actions,
  caption,
  actionsLabel = 'Actions',
  className,
  columns,
  density = 'comfortable',
  empty,
  getRowId,
  isLoading = false,
  loadingLabel,
  onSortChange,
  revealActions = true,
  rowHref,
  rowScroll,
  rows,
  sort,
}: DataTableProps<Row>) {
  if (!isLoading && rows.length === 0 && empty !== undefined) {
    return <>{empty}</>;
  }

  const colSpan = columns.length + (actions ? 1 : 0);
  const pad = CELL_PADDING[density];

  const followRow = (event: MouseEvent<HTMLTableRowElement>) => {
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = event.target as Element;
    if (target.closest(INTERACTIVE)) {
      return;
    }
    if (typeof window !== 'undefined' && window.getSelection()?.toString()) {
      return;
    }
    event.currentTarget.querySelector<HTMLAnchorElement>('a[data-row-link]')?.click();
  };

  return (
    <Table className={cn('max-sm:p-3', className)} stacked>
      {caption && <caption className="sr-only">{caption}</caption>}
      <THead>
        {columns.map((column) => (
          <Th
            align={column.align}
            className={column.width}
            key={column.id}
            onSort={onSortChange ? () => onSortChange(column.id) : undefined}
            sort={sortState(column, sort)}
          >
            {column.header}
          </Th>
        ))}
        {actions && (
          <Th align="right">
            <span className="sr-only">{actionsLabel}</span>
          </Th>
        )}
      </THead>
      <tbody>
        {isLoading ? (
          <TableStatusRow colSpan={colSpan}>
            <SkeletonRows label={loadingLabel} rows={6} />
          </TableStatusRow>
        ) : (
          rows.map((row) => {
            const href = rowHref?.(row);
            const rowActions = actions?.(row);
            const noActions =
              rowActions === null || rowActions === undefined || rowActions === false;
            return (
              <TRow
                className={cn('group', href && 'cursor-pointer')}
                hover
                key={getRowId(row)}
                onClick={href ? followRow : undefined}
              >
                {columns.map((column) => {
                  const content = column.cell(row);
                  const secondary = column.secondary?.(row);
                  return (
                    <Td
                      align={column.align}
                      className={cn(pad, column.width, column.primary && 'min-w-0')}
                      key={column.id}
                      label={
                        column.primary
                          ? undefined
                          : (column.label ??
                            (typeof column.header === 'string' ? column.header : undefined))
                      }
                      primary={column.primary}
                    >
                      {column.primary ? (
                        <>
                          {href ? (
                            <TableLink href={href} scroll={rowScroll}>
                              {content}
                            </TableLink>
                          ) : (
                            <div className="line-clamp-2 break-words font-medium text-paper-100">
                              {content}
                            </div>
                          )}
                          {secondary != null && secondary !== false && (
                            <div className="mt-0.5 text-xs text-paper-500">{secondary}</div>
                          )}
                        </>
                      ) : (
                        content
                      )}
                    </Td>
                  );
                })}
                {actions && (
                  <Td
                    align="right"
                    className={cn(pad, 'max-sm:text-left', noActions && 'max-sm:hidden')}
                  >
                    <div
                      className={cn(
                        'flex items-center justify-end gap-1.5 max-sm:justify-start',
                        revealActions && ROW_ACTION
                      )}
                    >
                      {rowActions}
                    </div>
                  </Td>
                )}
              </TRow>
            );
          })
        )}
      </tbody>
    </Table>
  );
}
