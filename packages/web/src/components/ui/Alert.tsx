import { cn } from '@/lib/utils';

type AlertVariant = 'error' | 'success' | 'warning' | 'info';

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  error: 'border-brick-400/40 bg-brick-400/10 text-brick-400',
  info: 'border-dust-400/40 bg-dust-400/10 text-paper-300',
  success: 'border-moss-400/40 bg-moss-400/10 text-moss-400',
  warning: 'border-amber-400/40 bg-amber-400/10 text-amber-400',
};

const VARIANT_PREFIX: Record<AlertVariant, string> = {
  error: '!',
  info: 'i',
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
        'rounded-md border px-3 py-2.5 text-sm',
        VARIANT_CLASSES[variant],
        className
      )}
      role={variant === 'error' ? 'alert' : 'status'}
    >
      {title ? (
        <>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em]">
            <span aria-hidden="true">{VARIANT_PREFIX[variant]}</span> {title}
          </div>
          <div className="text-xs leading-relaxed text-paper-300">{children}</div>
        </>
      ) : (
        <>
          <span aria-hidden="true">{VARIANT_PREFIX[variant]}</span> {children}
        </>
      )}
    </div>
  );
}
