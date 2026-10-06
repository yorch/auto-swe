import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { orgRoleLabel } from '@/lib/govLabels';
import { cn, FOCUS_RING, formatCents, formatPercent } from '@/lib/utils';

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
  const tone = org.alert.triggered ? (pct >= 100 ? 'bg-brick-400' : 'bg-amber-400') : 'bg-moss-400';
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
    cell: (org) => (
      <>
        <Link
          className={cn(
            'rounded-sm font-medium text-paper-100 hover:text-ember-300 hover:underline',
            FOCUS_RING
          )}
          href={`/govern/organizations/${org.id}`}
        >
          {org.name}
        </Link>
        <div className="mt-0.5 font-mono text-xs font-normal text-paper-500">{org.slug}</div>
      </>
    ),
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
        <Badge tone={org.role === 'ORG_ADMIN' ? 'ember' : 'neutral'} variant="outline">
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
        <Badge dot tone="brick">
          Over threshold
        </Badge>
      ) : (
        <Badge dot tone="moss" variant="text">
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

/**
 * Organizations with their monthly budget, spend, and alert state. The name
 * cell carries the slug as its secondary line, so `slug` is only needed as a
 * column of its own where the name is not shown; `nameLabel` renames the first one.
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
  const last = columns.length - 1;
  return (
    <Table stacked>
      <THead>
        {columns.map((col, i) => (
          <Th
            align={COLUMNS[col].alignRight ? 'right' : 'left'}
            className={cn(i === 0 && 'pl-0', i === last && 'pr-0')}
            key={col}
            variant="plain"
          >
            {col === 'name' ? nameLabel : COLUMNS[col].label}
          </Th>
        ))}
      </THead>
      <tbody>
        {rows.map((org) => (
          <TRow hover key={org.id}>
            {columns.map((col, i) => (
              <Td
                align={COLUMNS[col].alignRight ? 'right' : undefined}
                className={cn(
                  'px-4 py-3 text-[13px] text-paper-300',
                  COLUMNS[col].alignRight && 'tabular-nums',
                  i === 0 && 'pl-0',
                  i === last && 'pr-0'
                )}
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
  );
}
