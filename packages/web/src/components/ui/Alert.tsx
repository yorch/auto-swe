import { cn } from '@/lib/utils';
import { Icon, type IconName } from './Icon';

type AlertVariant = 'error' | 'success' | 'warning' | 'info';

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  error: 'border-brick-400/35 bg-brick-400/[0.07] text-brick-400',
  info: 'border-dust-400/30 bg-dust-400/[0.06] text-dust-400',
  success: 'border-moss-400/30 bg-moss-400/[0.07] text-moss-400',
  warning: 'border-amber-400/35 bg-amber-400/[0.07] text-amber-400',
};

const VARIANT_ACCENT: Record<AlertVariant, string> = {
  error: 'text-brick-400',
  info: 'text-dust-400',
  success: 'text-moss-400',
  warning: 'text-amber-400',
};

const VARIANT_ICON: Record<AlertVariant, IconName> = {
  error: 'error',
  info: 'info',
  success: 'checkCircle',
  warning: 'warning',
};

/**
 * An inline notice. The icon and the title carry the tone; the body stays in body
 * text so a long explanation is readable. Without a `title` the message itself
 * takes the tone colour, for a one-line status such as "Saved".
 */
export function Alert({
  action,
  children,
  className,
  title,
  variant = 'error',
}: {
  /** A trailing control — a "Fix this" link or a retry button. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** A heading line; the body then renders in body text rather than the tone colour. */
  title?: string;
  variant?: AlertVariant;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3.5 py-3 text-sm',
        VARIANT_CLASSES[variant],
        className
      )}
      role={variant === 'error' ? 'alert' : 'status'}
    >
      <Icon className={cn('mt-0.5', VARIANT_ACCENT[variant])} name={VARIANT_ICON[variant]} />
      <div className="min-w-0 flex-1">
        {title ? (
          <>
            <div className={cn('font-semibold leading-snug', VARIANT_ACCENT[variant])}>{title}</div>
            <div className="mt-1 text-[13px] leading-relaxed text-paper-300">{children}</div>
          </>
        ) : (
          <div className={cn('leading-snug', VARIANT_ACCENT[variant])}>{children}</div>
        )}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
