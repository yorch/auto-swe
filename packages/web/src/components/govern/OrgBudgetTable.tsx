'use client';

import { Badge } from '@/components/ui/Badge';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { useDataTableSort } from '@/hooks/useDataTableSort';
import { orgRoleLabel } from '@/lib/govLabels';
import { cn, formatCents, formatPercent } from '@/lib/utils';

/** The budget fields both the organizations list and the budget-alerts list carry. */
export interface OrgBudgetTableRow {
  alert: { percent: number | null; triggered: boolean };
  budgetAlertThresholdPercent: number | null;
  currentMonthUsage: { costUsdAccrued: number } | null;
  id: string;
  monthlyBudgetUsdCents: number | null;
  name: string;
  role?: string;
  slug: string;
}

export type OrgBudgetColumn =
  | 'name'
  | 'slug'
  | 'role'
  | 'cap'
  | 'spent'
  | 'threshold'
  | 'percentUsed'
  | 'status';

/** Spend against the cap as a thin bar plus the percent; status colour only when it matters. */
function UsageMeter({ org }: { org: OrgBudgetTableRow }) {
  if (org.alert.percent == null) {
    return <span className="text-paper-500">—</span>;
  }
  const pct = org.alert.percent;
  const threshold = org.budgetAlertThresholdPercent;
  const tone = org.alert.triggered
    ? pct >= 100
      ? 'bg-danger-400'
      : 'bg-warning-400'
    : 'bg-success-400';
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span
        aria-hidden
        className="relative hidden h-1.5 w-20 overflow-hidden rounded-full bg-ink-500 sm:block"
      >
        <span
          className={cn('absolute inset-y-0 left-0 rounded-full', tone)}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
        {threshold != null && threshold > 0 && threshold < 100 && (
          <span
            className="absolute inset-y-0 w-px bg-paper-300/70"
            style={{ left: `${threshold}%` }}
          />
        )}
      </span>
      <span className="tabular-nums">{formatPercent(pct / 100)}</span>
    </span>
  );
}

const COLUMNS: Record<
  OrgBudgetColumn,
  { label: string; alignRight: boolean; cell: (org: OrgBudgetTableRow) => React.ReactNode }
> = {
  cap: {
    alignRight: true,
    cell: (org) =>
      org.monthlyBudgetUsdCents == null ? (
        <span className="text-paper-500">No cap</span>
      ) : (
        formatCents(org.monthlyBudgetUsdCents)
      ),
    label: 'Monthly cap',
  },
  name: {
    alignRight: false,
    cell: (org) => org.name,
    label: 'Name',
  },
  percentUsed: {
    alignRight: true,
    cell: (org) => <UsageMeter org={org} />,
    label: 'Used',
  },
  role: {
    alignRight: false,
    cell: (org) =>
      org.role ? (
        <Badge tone={org.role === 'ORG_ADMIN' ? 'accent' : 'neutral'} variant="outline">
          {orgRoleLabel(org.role)}
        </Badge>
      ) : (
        <span className="text-paper-500">—</span>
      ),
    label: 'Your role',
  },
  slug: {
    alignRight: false,
    cell: (org) => <span className="font-mono text-xs text-paper-400">{org.slug}</span>,
    label: 'Slug',
  },
  // Accrued spend is in dollars; formatCents keeps $0.00 as a real value.
  spent: {
    alignRight: true,
    cell: (org) => formatCents((org.currentMonthUsage?.costUsdAccrued ?? 0) * 100),
    label: 'Spent this month',
  },
  status: {
    alignRight: true,
    cell: (org) =>
      org.alert.triggered ? (
        <Badge dot tone="danger">
          Over threshold
        </Badge>
      ) : (
        <Badge dot tone="success" variant="text">
          OK
        </Badge>
      ),
    label: 'Status',
  },
  threshold: {
    alignRight: true,
    cell: (org) =>
      org.budgetAlertThresholdPercent == null ? (
        <span className="text-paper-500">Not set</span>
      ) : (
        formatPercent(org.budgetAlertThresholdPercent / 100)
      ),
    label: 'Alert at',
  },
};

const SORT_KEYS = {
  cap: (org: OrgBudgetTableRow) => org.monthlyBudgetUsdCents,
  name: (org: OrgBudgetTableRow) => org.name.toLowerCase(),
  percentUsed: (org: OrgBudgetTableRow) => org.alert.percent,
  spent: (org: OrgBudgetTableRow) => org.currentMonthUsage?.costUsdAccrued ?? 0,
};

/**
 * Organizations with their monthly budget, spend, and alert state. The name
 * cell carries the slug as its secondary line, so `slug` is only needed as a
 * column of its own where the name is not shown; `nameLabel` renames the first one.
 * The name opens the organization; name, cap, spend and share used sort the list.
 */
export function OrgBudgetTable({
  columns,
  nameLabel = 'Organization',
  rows,
}: {
  columns: OrgBudgetColumn[];
  nameLabel?: string;
  rows: OrgBudgetTableRow[];
}) {
  const { onSortChange, sort, sortRows } = useDataTableSort<OrgBudgetTableRow>(SORT_KEYS);

  return (
    // Bleeds into the card's padding so cell text lines up with the card's heading.
    <div className="-mx-4">
      <DataTable
        className="max-sm:px-4"
        columns={columns.map((col): DataTableColumn<OrgBudgetTableRow> => {
          const { alignRight, cell, label } = COLUMNS[col];
          const header = col === 'name' ? nameLabel : label;
          return col === 'name'
            ? {
                cell: (org) => org.name,
                header,
                id: col,
                primary: true,
                secondary: (org) => <span className="font-mono">{org.slug}</span>,
                sortable: true,
              }
            : {
                align: alignRight ? 'right' : undefined,
                cell: (org) => (
                  <span className={cn('text-sm text-paper-300', alignRight && 'tabular-nums')}>
                    {cell(org)}
                  </span>
                ),
                header,
                id: col,
                sortable: col in SORT_KEYS,
              };
        })}
        getRowId={(org) => org.id}
        onSortChange={onSortChange}
        rowHref={(org) => `/admin/organizations/${org.id}`}
        rows={sortRows(rows)}
        sort={sort}
      />
    </div>
  );
}
