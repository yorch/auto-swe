import { cn } from '@/lib/utils';

type CardVariant = 'panel' | 'inset' | 'ghost';

const VARIANT_CLASSES: Record<CardVariant, string> = {
  ghost: 'border border-transparent bg-transparent',
  inset: 'border border-ink-600/60 bg-ink-700/30',
  panel: 'border border-ink-600/60 bg-ink-700',
};

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
};

export function Card({ className, children, variant = 'panel', ...props }: CardProps) {
  return (
    <div
      className={cn('relative p-6 transition-colors', VARIANT_CLASSES[variant], className)}
      style={{ borderRadius: '4px' }}
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
    <div className={cn('mb-4 flex items-baseline justify-between gap-4', className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, eyebrow }: { children: React.ReactNode; eyebrow?: string }) {
  return (
    <div>
      {eyebrow && <div className="kicker mb-1">{eyebrow}</div>}
      <h3
        className="text-xl text-paper-100"
        style={{ fontFamily: 'var(--font-display)', fontWeight: 500, letterSpacing: '-0.01em' }}
      >
        {children}
      </h3>
    </div>
  );
}
