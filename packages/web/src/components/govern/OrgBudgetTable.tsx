import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { orgRoleLabel } from '@/lib/govLabels';
import { formatCents, formatPercent } from '@/lib/utils';

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

const COLUMNS: Record<
  OrgBudgetColumn,
  { label: string; alignRight: boolean; cell: (org: OrgBudgetTableRow) => React.ReactNode }
> = {
  cap: {
    alignRight: true,
    cell: (org) =>
      org.monthlyBudgetUsdCents == null ? 'No cap' : formatCents(org.monthlyBudgetUsdCents),
    label: 'Monthly cap',
  },
  name: {
    alignRight: false,
    cell: (org) => (
      <Link className="text-ember-400 hover:underline" href={`/govern/organizations/${org.id}`}>
        {org.name}
      </Link>
    ),
    label: 'Name',
  },
  percentUsed: {
    alignRight: true,
    cell: (org) => (org.alert.percent == null ? '—' : formatPercent(org.alert.percent / 100)),
    label: '% used',
  },
  role: {
    alignRight: false,
    cell: (org) => (org.role ? orgRoleLabel(org.role) : '—'),
    label: 'Role',
  },
  slug: {
    alignRight: false,
    cell: (org) => <span className="font-mono text-[11px] text-paper-400">{org.slug}</span>,
    label: 'Slug',
  },
  // Accrued spend is in dollars; formatCents keeps $0.00 as a real value.
  spent: {
    alignRight: true,
    cell: (org) => formatCents((org.currentMonthUsage?.costUsdAccrued ?? 0) * 100),
    label: 'Spent',
  },
  status: {
    alignRight: true,
    cell: (org) =>
      org.alert.triggered ? (
        <Badge className="text-[11px]" tone="brick">
          Alert
        </Badge>
      ) : (
        <Badge className="text-[11px]" tone="moss">
          OK
        </Badge>
      ),
    label: 'Status',
  },
  threshold: {
    alignRight: true,
    cell: (org) =>
      org.budgetAlertThresholdPercent == null
        ? '—'
        : formatPercent(org.budgetAlertThresholdPercent / 100),
    label: 'Threshold',
  },
};

/**
 * Organizations with their monthly budget, spend, and alert state. The
 * organizations list and the budget-alerts list show different subsets of the
 * same columns; `nameLabel` renames the first one.
 */
export function OrgBudgetTable({
  columns,
  nameLabel = 'Name',
  rows,
}: {
  columns: OrgBudgetColumn[];
  nameLabel?: string;
  rows: OrgBudgetTableRow[];
}) {
  return (
    <div className="overflow-x-auto">
      <Table stacked>
        <THead className="text-left text-xs text-paper-400">
          {columns.map((col) => (
            <Th align={COLUMNS[col].alignRight ? 'right' : 'left'} key={col} variant="dense">
              {col === 'name' ? nameLabel : COLUMNS[col].label}
            </Th>
          ))}
        </THead>
        <tbody>
          {rows.map((org) => (
            <TRow key={org.id}>
              {columns.map((col) => (
                <Td
                  align={COLUMNS[col].alignRight ? 'right' : undefined}
                  className={COLUMNS[col].alignRight ? 'px-4 py-2 tabular-nums' : 'px-4 py-2'}
                  key={col}
                  label={col === 'name' ? undefined : COLUMNS[col].label}
                  primary={col === 'name'}
                >
                  {COLUMNS[col].cell(org)}
                </Td>
              ))}
            </TRow>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
