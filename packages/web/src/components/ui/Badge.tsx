import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type BadgeTone =
  | 'success'
  | 'warning'
  | 'danger'
  | 'accent2'
  | 'info'
  | 'accent'
  | 'neutral'
  | 'muted';
export type BadgeVariant = 'solid' | 'outline' | 'text';

// Full literal class strings so Tailwind's scanner sees every one.
const TONE_CLASSES: Record<BadgeTone, Record<BadgeVariant, string>> = {
  accent: {
    outline: 'border-accent-400/30 bg-accent-400/10 text-accent-400',
    solid: 'bg-accent-400/20 text-accent-400',
    text: 'text-accent-400',
  },
  accent2: {
    outline: 'border-accent2-400/30 bg-accent2-400/10 text-accent2-400',
    solid: 'bg-accent2-400/20 text-accent2-400',
    text: 'text-accent2-400',
  },
  danger: {
    outline: 'border-danger-400/30 bg-danger-400/10 text-danger-400',
    solid: 'bg-danger-400/20 text-danger-400',
    text: 'text-danger-400',
  },
  info: {
    outline: 'border-info-400/30 bg-info-400/10 text-info-400',
    solid: 'bg-info-400/20 text-info-400',
    text: 'text-info-400',
  },
  muted: {
    outline: 'border-ink-500 bg-ink-700 text-paper-400',
    solid: 'bg-ink-600 text-paper-400',
    text: 'text-paper-400',
  },
  neutral: {
    outline: 'border-ink-500 bg-ink-700 text-paper-400',
    solid: 'bg-ink-600 text-paper-400',
    text: 'text-paper-400',
  },
  success: {
    outline: 'border-success-400/30 bg-success-400/10 text-success-400',
    solid: 'bg-success-400/20 text-success-400',
    text: 'text-success-400',
  },
  warning: {
    outline: 'border-warning-400/30 bg-warning-400/10 text-warning-400',
    solid: 'bg-warning-400/20 text-warning-400',
    text: 'text-warning-400',
  },
};

const VARIANT_BASE: Record<BadgeVariant, string> = {
  outline: 'inline-flex items-center rounded-sm border px-1.5 py-px leading-5',
  solid: 'inline-flex items-center rounded-sm px-1.5 py-px leading-5',
  text: '',
};

/**
 * Small inline label with a semantic colour. `solid` is a tinted label,
 * `outline` a bordered one, `text` colour only. Every badge shares the 4px
 * (`rounded-sm`) shape — do not round one into a pill. Size / spacing tweaks go
 * through `className` (merged with tailwind-merge, so overrides win).
 * Workflow / run statuses have their own `StatusBadge`; this is for everything
 * else that used to hand-roll a coloured span.
 */
export function Badge({
  children,
  className,
  dot = false,
  title,
  tone,
  uppercase = false,
  variant = 'solid',
}: {
  children: ReactNode;
  className?: string;
  /** Leading status dot in the badge's own colour; `'pulse'` animates the dot alone, for a live state. */
  dot?: boolean | 'pulse';
  title?: string;
  tone: BadgeTone;
  uppercase?: boolean;
  variant?: BadgeVariant;
}) {
  return (
    <span
      className={cn(
        'whitespace-nowrap text-xs font-medium',
        VARIANT_BASE[variant],
        dot && 'inline-flex items-center gap-1.5',
        uppercase && 'text-2xs uppercase tracking-[0.06em]',
        TONE_CLASSES[tone][variant],
        className
      )}
      title={title}
    >
      {dot && (
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full bg-current',
            dot === 'pulse' && 'pulse-dot'
          )}
        />
      )}
      {children}
    </span>
  );
}
