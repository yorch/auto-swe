import { cn } from '@/lib/utils';

type AlertVariant = 'error' | 'success';

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  error: 'border-brick-400/40 bg-brick-400/10 text-brick-400',
  success: 'border-moss-400/40 bg-moss-400/10 text-moss-400',
};

const VARIANT_PREFIX: Record<AlertVariant, string> = {
  error: '!',
  success: '✓',
};

export function Alert({
  children,
  className,
  variant = 'error',
}: {
  children: React.ReactNode;
  className?: string;
  variant?: AlertVariant;
}) {
  return (
    <div
      className={cn(
        'rounded-sm border px-3 py-2 font-mono text-[11px] uppercase tracking-wider',
        VARIANT_CLASSES[variant],
        className
      )}
    >
      {VARIANT_PREFIX[variant]} {children}
    </div>
  );
}
