import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';

/**
 * The heading of a launch form's card: its title and a two-step "Details → Review"
 * indicator, so every way of starting work reads as the same guided flow.
 */
export function LaunchCardHeader({
  description,
  stage,
  title,
}: {
  description?: ReactNode;
  stage: 'details' | 'review';
  title: string;
}) {
  const steps = [
    { id: 'details', label: 'Details' },
    { id: 'review', label: 'Review' },
  ] as const;
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-ink-600 pb-4">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-tight text-paper-50">{title}</h2>
        {description && <p className="mt-1 text-sm text-paper-400">{description}</p>}
      </div>
      <ol aria-label="Launch progress" className="flex shrink-0 items-center gap-2 text-xs">
        {steps.map((step, index) => {
          const current = step.id === stage;
          const done = stage === 'review' && step.id === 'details';
          return (
            <li className="flex items-center gap-2" key={step.id}>
              {index > 0 && <span aria-hidden="true" className="h-px w-4 bg-ink-400" />}
              <span
                aria-current={current ? 'step' : undefined}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
                  current
                    ? 'border-ember-400/50 bg-ember-400/10 text-ember-300'
                    : done
                      ? 'border-ink-400 text-paper-300'
                      : 'border-ink-500 text-paper-500'
                )}
              >
                {done ? (
                  <Icon name="check" size={11} strokeWidth={2.6} />
                ) : (
                  <span className="tabular">{index + 1}</span>
                )}
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export interface ReviewItem {
  label: string;
  value: ReactNode;
  /** Code-like value (an id, a branch): rendered in mono. */
  mono?: boolean;
  /** Keep the value's own line breaks (a prompt, a description). */
  multiline?: boolean;
}

/** The "what will launch" summary: label on the left, value on the right, stacked on mobile. */
export function ReviewList({ items }: { items: ReviewItem[] }) {
  return (
    <dl className="divide-y divide-ink-600 rounded-lg border border-ink-500/60 bg-ink-900/40 text-sm">
      {items.map((item) => (
        <div
          className="grid gap-1 px-4 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4"
          key={item.label}
        >
          <dt className="text-paper-400">{item.label}</dt>
          <dd
            className={cn(
              'min-w-0 break-words text-paper-100',
              item.mono && 'font-mono text-[13px]',
              item.multiline && 'whitespace-pre-wrap'
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
