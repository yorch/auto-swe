import type { BudgetState, BudgetStatus } from '@auto-swe/shared/types/api';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';

const SCOPE_NOUN: Record<BudgetStatus['scope'], string> = {
  org: 'org budget',
  team: 'team budget',
};

/** The progress bar's own name; the words of the state are its value text and the visible label. */
const SCOPE_TITLE: Record<BudgetStatus['scope'], string> = {
  org: 'Organization budget',
  team: 'Team budget',
};

/** Full literal class strings so Tailwind's scanner sees every one. */
const STATE_STYLE: Record<BudgetState, { bar: string; text: string }> = {
  alert: { bar: 'bg-warning-400', text: 'text-warning-400' },
  no_cap: { bar: 'bg-ink-400', text: 'text-paper-400' },
  ok: { bar: 'bg-success-400', text: 'text-paper-300' },
  over: { bar: 'bg-danger-400', text: 'text-danger-400' },
  projected_over: { bar: 'bg-warning-400', text: 'text-warning-400' },
};

function clampPercent(value: number | null): number {
  return value === null || Number.isNaN(value) ? 0 : Math.max(0, Math.min(100, value));
}

/**
 * The words for a budget: always the whole story, so colour is never the only signal. Percent
 * only, never dollars. Exported for tests and for places that need the text without the bar.
 */
export function budgetLabel(budget: BudgetStatus): string {
  const noun = SCOPE_NOUN[budget.scope];
  // Floored, never rounded up: 99.96% must not read as 100% while the budget is not over.
  const percent = budget.percentUsed === null ? null : Math.floor(budget.percentUsed);
  switch (budget.state) {
    case 'no_cap':
      return 'No budget limit';
    case 'over':
      return `Over the ${noun}`;
    case 'projected_over':
      return percent === null
        ? `On track to pass the ${noun} this month`
        : `${percent}% of the ${noun} this month, on track to pass it`;
    case 'alert':
      return percent === null
        ? `Nearing the ${noun} this month`
        : `${percent}% of the ${noun} this month, nearing the limit`;
    default:
      return percent === null
        ? `Within the ${noun} this month`
        : `${percent}% of the ${noun} this month`;
  }
}

/**
 * Month-to-date spend against the cap that binds a team's work, as a progress bar with a text
 * label. Renders nothing without a budget. `compact` is a thin bar with a one-line label for a
 * card; the full variant adds the alert threshold.
 */
export function BudgetMeter({
  budget,
  className,
  variant = 'full',
}: {
  budget: BudgetStatus | null | undefined;
  variant?: 'compact' | 'full';
  className?: string;
}) {
  if (!budget) {
    return null;
  }
  const label = budgetLabel(budget);
  const style = STATE_STYLE[budget.state];
  const width = budget.state === 'over' ? 100 : Math.floor(clampPercent(budget.percentUsed));
  const hasBar = budget.state !== 'no_cap';
  const threshold = budget.alertThresholdPercent;
  const warn = budget.state === 'alert' || budget.state === 'projected_over';
  return (
    <div className={cn('min-w-0', className)} data-state={budget.state} data-testid="budget-meter">
      <div className={cn('flex items-center gap-1.5 text-xs', style.text)}>
        {(warn || budget.state === 'over') && (
          <Icon
            name={budget.state === 'over' ? 'alert' : 'clock'}
            size={variant === 'compact' ? 12 : 14}
          />
        )}
        <span className="min-w-0">{label}</span>
      </div>
      {hasBar && (
        <div
          aria-label={SCOPE_TITLE[budget.scope]}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={width}
          aria-valuetext={label}
          className={cn(
            'relative mt-1.5 overflow-hidden rounded-full bg-ink-600',
            variant === 'compact' ? 'h-1' : 'h-2'
          )}
          role="progressbar"
        >
          <div
            className={cn('h-full rounded-full transition-[width]', style.bar)}
            style={{ width: `${width}%` }}
          />
          {variant === 'full' && threshold !== null && threshold > 0 && threshold < 100 && (
            <div
              aria-hidden="true"
              className="absolute top-0 h-full w-px bg-paper-300"
              style={{ left: `${threshold}%` }}
            />
          )}
        </div>
      )}
      {variant === 'full' && hasBar && threshold !== null && (
        <p className="mt-1 text-xs text-paper-500">Alerts at {threshold}%.</p>
      )}
    </div>
  );
}
