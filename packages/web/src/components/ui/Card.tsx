import { cn } from '@/lib/utils';

type CardVariant = 'panel' | 'inset' | 'ghost';

const VARIANT_CLASSES: Record<CardVariant, string> = {
  ghost: 'border border-transparent bg-transparent',
  inset: 'border border-ink-600 bg-ink-800/40',
  panel: 'border border-ink-600 bg-ink-800',
};

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
};

export function Card({ className, children, variant = 'panel', ...props }: CardProps) {
  return (
    <div
      className={cn(
        'relative rounded-sm p-6 transition-colors',
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
    <div className={cn('mb-5 flex items-baseline justify-between gap-4', className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, eyebrow }: { children: React.ReactNode; eyebrow?: string }) {
  return (
    <div>
      {eyebrow && (
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
          {eyebrow}
        </div>
      )}
      <h3 className="font-display text-xl font-medium tracking-tight text-paper-100">{children}</h3>
    </div>
  );
}
