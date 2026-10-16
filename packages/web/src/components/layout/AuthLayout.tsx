import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { Icon, type IconName } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';

/**
 * The product mark: a flat violet tile plus the "auto·swe" wordmark, shared by
 * the sidebar and the sign-in screens. The tile is a bespoke logo, not an icon,
 * so it stays an inline SVG rather than an `Icon`. Flat on purpose — no gradient,
 * no glow — and the wordmark is upright type in the UI face.
 */
export function BrandMark({
  className,
  size = 'md',
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const tile = {
    lg: 'h-10 w-10 rounded-lg',
    md: 'h-8 w-8 rounded-lg',
    sm: 'h-[26px] w-[26px] rounded-sm',
  }[size];
  const glyph = { lg: 22, md: 18, sm: 15 }[size];
  const text = { lg: 'text-2xl', md: 'text-xl', sm: 'text-lg' }[size];
  return (
    <span
      className={cn('inline-flex items-center', size === 'sm' ? 'gap-3' : 'gap-2.5', className)}
    >
      <span
        aria-hidden="true"
        className={cn('flex shrink-0 items-center justify-center bg-accent-500 text-white', tile)}
      >
        <svg aria-hidden="true" fill="none" height={glyph} viewBox="0 0 24 24" width={glyph}>
          <path
            d="M4 7h7M4 12h16M13 17h7"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth={2.2}
          />
          <circle cx={17} cy={7} fill="currentColor" r={2.4} />
          <circle cx={7} cy={17} fill="currentColor" r={2.4} />
        </svg>
      </span>
      <span className={cn('tracking-[-0.02em]', text)}>
        <span className="font-bold text-paper-50">auto</span>
        <span className="font-medium text-paper-400">·swe</span>
      </span>
    </span>
  );
}

/**
 * The chromeless ground the sign-in screens share: the brand mark above a
 * centred card on the plain page ground. `login` places it in the right half of its
 * split layout and shows the mark on narrow screens only (`brand="mobile"`),
 * since its left panel carries the mark on wide ones; the single-panel screens
 * (reset password, awaiting approval) fill the viewport with it. `embedded`
 * is for a screen that renders inside the app shell (app consent): the shell
 * already carries the mark and the page ground, so only the centred card stays.
 */
export function AuthLayout({
  brand = 'always',
  children,
  className,
  embedded = false,
  footer,
}: {
  brand?: 'always' | 'mobile';
  children: ReactNode;
  className?: string;
  embedded?: boolean;
  /** A line under the card — a "Back to sign in" link, a version string. */
  footer?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center',
        embedded
          ? 'min-h-[calc(100dvh-12rem)] py-4'
          : 'min-h-dvh overflow-hidden bg-ink-800 px-4 py-10 sm:px-6',
        className
      )}
    >
      <div className={cn('relative w-full', embedded ? 'max-w-[460px]' : 'max-w-[420px]')}>
        {!embedded && (
          <div className={cn('mb-8 flex justify-center', brand === 'mobile' && 'lg:hidden')}>
            <BrandMark />
          </div>
        )}
        <Card className="rounded-2xl p-6 sm:p-8">{children}</Card>
        {footer && (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-paper-500">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

type HeadingTone = 'neutral' | 'success' | 'warning' | 'danger';

const TONE_CHIP: Record<HeadingTone, string> = {
  danger: 'border-danger-400/30 bg-danger-400/10 text-danger-400',
  neutral: 'border-ink-400 bg-ink-600 text-paper-300',
  success: 'border-success-400/30 bg-success-400/10 text-success-400',
  warning: 'border-warning-400/30 bg-warning-400/10 text-warning-400',
};

/**
 * The opening of every auth card: an optional icon, the heading, and a lede.
 * The icon takes `tone`, so a success or pending screen reads as such before a
 * word of it is read — and the words still say it, so the state is never colour
 * alone. Neutral is the default: a status colour only where there is a status.
 */
export function AuthHeading({
  children,
  icon,
  title,
  tone = 'neutral',
}: {
  /** Lede under the heading. */
  children?: ReactNode;
  icon?: IconName;
  title: string;
  tone?: HeadingTone;
}) {
  return (
    <div className="mb-6">
      {icon && (
        <div
          aria-hidden="true"
          className={cn(
            'mb-4 flex h-11 w-11 items-center justify-center rounded-xl border',
            TONE_CHIP[tone]
          )}
        >
          <Icon name={icon} size={20} />
        </div>
      )}
      <h1 className="text-2xl font-semibold tracking-[-0.02em] text-paper-50">{title}</h1>
      {children && <div className="mt-2 text-sm leading-relaxed text-paper-400">{children}</div>}
    </div>
  );
}
