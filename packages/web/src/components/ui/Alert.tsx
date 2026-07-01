import { cn } from '@/lib/utils';

type AlertVariant = 'error' | 'success' | 'warning';

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  error: 'border-brick-400/40 bg-brick-400/10 text-brick-400',
  success: 'border-moss-400/40 bg-moss-400/10 text-moss-400',
  warning: 'border-amber-400/40 bg-amber-400/10 text-amber-400',
};

const VARIANT_PREFIX: Record<AlertVariant, string> = {
  error: '!',
  success: '✓',
  warning: '!',
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
        'border px-3 py-2.5 text-sm',
        'rounded-[9px]',
        VARIANT_CLASSES[variant],
        className
      )}
    >
      {VARIANT_PREFIX[variant]} {children}
    </div>
  );
}
