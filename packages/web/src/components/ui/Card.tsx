import { cn } from '@/lib/utils';

type CardVariant = 'panel' | 'inset' | 'ghost';

const VARIANT_CLASSES: Record<CardVariant, string> = {
  ghost: 'border border-transparent bg-transparent',
  inset: 'border border-ink-400/40 bg-ink-900/50',
  panel:
    // Flat: a solid fill and a visible border define the card, with no gradient (a card that
    // fades toward the page loses its bottom edge) and no drop shadow.
    'border border-ink-400 bg-ink-700',
};

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
};

export function Card({ className, children, variant = 'panel', ...props }: CardProps) {
  return (
    <div
      className={cn(
        'relative rounded-xl p-4 transition-colors sm:p-6',
        VARIANT_CLASSES[variant],
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2',
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A card's heading, with an optional `hint` under it for what the title alone does
 * not say — the window a chart covers, the order of a list, the test behind a figure.
 */
export function CardTitle({
  as: Heading = 'h3',
  children,
  hint,
}: {
  /** The heading level. `h3` assumes a section heading above; use `h2` directly under a page's `h1`. */
  as?: 'h2' | 'h3' | 'h4';
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <Heading className="text-lg font-semibold tracking-tight text-paper-50">{children}</Heading>
      {hint && <p className="mt-0.5 text-sm text-paper-500">{hint}</p>}
    </div>
  );
}
