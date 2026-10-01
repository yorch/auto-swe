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
  title,
  variant = 'error',
}: {
  children: React.ReactNode;
  className?: string;
  /** A mono heading line; the body then renders in body text rather than the tone colour. */
  title?: string;
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
      role={variant === 'error' ? 'alert' : 'status'}
    >
      {title ? (
        <>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em]">
            {VARIANT_PREFIX[variant]} {title}
          </div>
          <div className="text-xs leading-relaxed text-paper-300">{children}</div>
        </>
      ) : (
        <>
          {VARIANT_PREFIX[variant]} {children}
        </>
      )}
    </div>
  );
}
