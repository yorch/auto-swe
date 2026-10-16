import { cn } from '@/lib/utils';
import { Icon, type IconName } from './Icon';

type AlertVariant = 'error' | 'success' | 'warning' | 'info';

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  error: 'border-danger-400/35 bg-danger-400/[0.07] text-danger-400',
  info: 'border-info-400/30 bg-info-400/[0.06] text-info-400',
  success: 'border-success-400/30 bg-success-400/[0.07] text-success-400',
  warning: 'border-warning-400/35 bg-warning-400/[0.07] text-warning-400',
};

const VARIANT_ACCENT: Record<AlertVariant, string> = {
  error: 'text-danger-400',
  info: 'text-info-400',
  success: 'text-success-400',
  warning: 'text-warning-400',
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
  announce = true,
  children,
  className,
  title,
  variant = 'error',
}: {
  /** A trailing control — a "Fix this" link or a retry button. */
  action?: React.ReactNode;
  /**
   * true (default): the notice is a live region — `alert` for `error`, `status` otherwise —
   * so a message that appears after an action is announced. false: a static callout that is on
   * the page at load; it carries `role="note"`, which is not a live region, so nothing is
   * announced on render.
   */
  announce?: boolean;
  children: React.ReactNode;
  className?: string;
  /** A heading line; the body then renders in body text rather than the tone colour. */
  title?: string;
  variant?: AlertVariant;
}) {
  let role: 'alert' | 'status' | 'note';
  if (!announce) {
    role = 'note';
  } else {
    role = variant === 'error' ? 'alert' : 'status';
  }
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3.5 py-3 text-sm',
        VARIANT_CLASSES[variant],
        className
      )}
      role={role}
    >
      <Icon className={cn('mt-0.5', VARIANT_ACCENT[variant])} name={VARIANT_ICON[variant]} />
      <div className="min-w-0 flex-1">
        {title ? (
          <>
            <div className={cn('font-semibold leading-snug', VARIANT_ACCENT[variant])}>{title}</div>
            <div className="mt-1 text-sm leading-relaxed text-paper-300">{children}</div>
          </>
        ) : (
          <div className={cn('leading-snug', VARIANT_ACCENT[variant])}>{children}</div>
        )}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
