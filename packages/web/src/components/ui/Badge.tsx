import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type BadgeTone =
  | 'moss'
  | 'amber'
  | 'brick'
  | 'violet'
  | 'dust'
  | 'ember'
  | 'neutral'
  | 'muted';
export type BadgeVariant = 'solid' | 'outline' | 'text';

// Full literal class strings so Tailwind's scanner sees every one.
const TONE_CLASSES: Record<BadgeTone, Record<BadgeVariant, string>> = {
  amber: {
    outline: 'border-amber-400/30 bg-amber-400/10 text-amber-400',
    solid: 'bg-amber-400/20 text-amber-400',
    text: 'text-amber-400',
  },
  brick: {
    outline: 'border-brick-400/30 bg-brick-400/10 text-brick-400',
    solid: 'bg-brick-400/20 text-brick-400',
    text: 'text-brick-400',
  },
  dust: {
    outline: 'border-dust-400/30 bg-dust-400/10 text-dust-400',
    solid: 'bg-dust-400/20 text-dust-400',
    text: 'text-dust-400',
  },
  ember: {
    outline: 'border-ember-400/30 bg-ember-400/10 text-ember-400',
    solid: 'bg-ember-400/20 text-ember-400',
    text: 'text-ember-400',
  },
  moss: {
    outline: 'border-moss-400/30 bg-moss-400/10 text-moss-400',
    solid: 'bg-moss-400/20 text-moss-400',
    text: 'text-moss-400',
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
  violet: {
    outline: 'border-violet-400/30 bg-violet-400/10 text-violet-400',
    solid: 'bg-violet-400/20 text-violet-400',
    text: 'text-violet-400',
  },
};

const VARIANT_BASE: Record<BadgeVariant, string> = {
  outline: 'inline-flex items-center rounded-md border px-1.5 py-px leading-5',
  solid: 'inline-flex items-center rounded-md px-1.5 py-px leading-5',
  text: '',
};

/**
 * Small inline label with a semantic colour. `solid` is a tinted pill,
 * `outline` a bordered pill, `text` colour only. Size / spacing tweaks go
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
        'whitespace-nowrap text-[11.5px] font-medium',
        VARIANT_BASE[variant],
        dot && 'inline-flex items-center gap-1.5',
        uppercase && 'text-[10.5px] uppercase tracking-[0.06em]',
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
