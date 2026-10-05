import { createContext, type ReactNode, useContext } from 'react';
import { cn } from '@/lib/utils';

type Align = 'left' | 'right' | 'center';
const ALIGN: Record<Align, string> = {
  center: 'text-center',
  left: 'text-left',
  right: 'text-right',
};

const StackedContext = createContext(false);

/** Below `sm`, a stacked table turns each body row into a card; see `Table`. */
const STACKED_TABLE =
  'max-sm:[&_thead]:sr-only max-sm:[&_tbody]:block max-sm:[&_thead_tr]:block ' +
  'max-sm:[&_tbody_tr]:mb-3 max-sm:[&_tbody_tr]:block max-sm:[&_tbody_tr]:rounded-md ' +
  'max-sm:[&_tbody_tr]:border max-sm:[&_tbody_tr]:border-ink-600 max-sm:[&_tbody_tr]:px-3 ' +
  'max-sm:[&_tbody_tr]:py-2 max-sm:[&_tbody_tr:last-child]:mb-0 max-sm:block';

/**
 * The table scrolls inside its own wrapper, so a wide table on a narrow screen
 * never widens the page itself.
 *
 * Pass `stacked` for a table with many columns (6+): below the `sm` breakpoint
 * each body row renders as a card instead of scrolling sideways, so a row's
 * actions never sit off-screen. The header row is kept for screen readers only.
 * Tell each `Td` what it is:
 *
 *   <Table stacked>
 *     <THead>...</THead>
 *     <tbody>
 *       <TRow>
 *         <Td primary>{name}</Td>                  // the card title, no label
 *         <Td label="Status">{status}</Td>         // a "Status  value" line
 *         <Td align="right">{actions}</Td>         // unlabelled: full width, left-aligned
 *       </TRow>
 *     </tbody>
 *   </Table>
 *
 * From `sm` up nothing changes, so `label` and `primary` cost nothing on a wide
 * screen. A `Td` without either still renders, as a plain full-width line.
 */
export function Table({
  children,
  className,
  stacked = false,
}: {
  children: ReactNode;
  className?: string;
  stacked?: boolean;
}) {
  return (
    <StackedContext.Provider value={stacked}>
      <div className="w-full overflow-x-auto">
        <table className={cn('w-full text-sm', stacked && STACKED_TABLE, className)}>
          {children}
        </table>
      </div>
    </StackedContext.Provider>
  );
}

/** Header row (`<thead><tr>`). `className` carries a row background or text treatment. */
export function THead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead>
      <tr className={cn('border-b border-ink-600', className)}>{children}</tr>
    </thead>
  );
}

/**
 * The header treatments in use: `mono` (small caps, admin lists), `plain`
 * (main list pages), `compact` (dense admin cards without side padding) and
 * `dense` (numeric admin tables). New tables should pick `mono` or `plain`.
 */
export type ThVariant = 'mono' | 'plain' | 'compact' | 'dense';
const TH_VARIANT: Record<ThVariant, string> = {
  compact: 'py-2 text-xs text-paper-500',
  dense: 'px-4 py-2 font-medium',
  mono: 'px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500',
  plain: 'px-4 py-3 font-medium',
};

export type SortDirection = 'ascending' | 'descending' | 'none';

/**
 * `sort` makes the header sortable: the `<th>` carries `aria-sort` and the
 * label becomes a button that calls `onSort`, with a direction arrow that
 * screen readers skip (the state is already in `aria-sort`).
 */
export function Th({
  align = 'left',
  children,
  className,
  onSort,
  sort,
  variant = 'mono',
}: {
  align?: Align;
  children?: ReactNode;
  className?: string;
  onSort?: () => void;
  sort?: SortDirection;
  variant?: ThVariant;
}) {
  const sortable = sort !== undefined;
  return (
    <th
      aria-sort={sort}
      className={cn(TH_VARIANT[variant], ALIGN[align], className)}
      scope={sortable ? 'col' : undefined}
    >
      {sortable ? (
        <button
          className={cn('hover:underline', sort === 'none' ? 'text-paper-400' : 'text-paper-200')}
          onClick={onSort}
          type="button"
        >
          {children}
          <span aria-hidden="true">
            {sort === 'descending' ? ' ↓' : sort === 'ascending' ? ' ↑' : ''}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

/** Body row with the standard divider; `hover` adds the row highlight. */
export function TRow({
  children,
  className,
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <tr
      className={cn(
        'border-b border-ink-600 last:border-0',
        hover && 'transition-colors hover:bg-ink-800',
        className
      )}
    >
      {children}
    </tr>
  );
}

/**
 * A full-width body row for a table's loading, empty or error state, so the
 * header stays in place while the body explains itself. Pass `LoadingState`,
 * `EmptyState` or `Alert` as `children`.
 */
export function TableStatusRow({ children, colSpan }: { children: ReactNode; colSpan: number }) {
  return (
    <tr>
      <td className="px-4 py-2" colSpan={colSpan}>
        {children}
      </td>
    </tr>
  );
}

export function Td({
  align,
  children,
  className,
  colSpan,
  label,
  primary = false,
  title,
}: {
  align?: Align;
  children?: ReactNode;
  className?: string;
  colSpan?: number;
  /** In a `stacked` table below `sm`: the caption shown beside this cell's value. */
  label?: string;
  /** In a `stacked` table below `sm`: this cell is the card's title. */
  primary?: boolean;
  title?: string;
}) {
  const stacked = useContext(StackedContext);
  return (
    <td
      className={cn(
        align && ALIGN[align],
        stacked &&
          cn(
            'max-sm:block max-sm:px-0! max-sm:py-1! max-sm:text-left',
            primary && 'max-sm:text-base max-sm:font-medium',
            label && 'max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3'
          ),
        className
      )}
      colSpan={colSpan}
      title={title}
    >
      {stacked && label ? (
        <>
          {/* A real element, not CSS content: Safari drops table semantics on the
              display:block cells, and generated content is not reliably announced. */}
          <span className="hidden shrink-0 text-xs text-paper-500 max-sm:inline">{label}</span>
          <span className="min-w-0 max-sm:flex-1 max-sm:text-right">{children}</span>
        </>
      ) : (
        children
      )}
    </td>
  );
}
