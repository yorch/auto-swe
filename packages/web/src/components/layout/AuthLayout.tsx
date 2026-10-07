import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { Icon, type IconName } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';

/**
 * The product mark: the gradient tile plus the "auto·swe" wordmark, drawn the
 * same way the sidebar draws it. The tile is a bespoke logo, not an icon, so it
 * stays an inline SVG rather than an `Icon`.
 */
export function BrandMark({ className, size = 'md' }: { className?: string; size?: 'md' | 'lg' }) {
  const lg = size === 'lg';
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-ember-400 to-violet-400 shadow-[0_8px_24px_-8px_color-mix(in_oklab,var(--color-ember-400)_70%,transparent)]',
          lg ? 'h-10 w-10' : 'h-8 w-8'
        )}
      >
        <svg
          aria-hidden="true"
          className="text-paper-50"
          fill="none"
          height={lg ? 22 : 18}
          viewBox="0 0 24 24"
          width={lg ? 22 : 18}
        >
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
      <span className="flex items-baseline gap-[3px]">
        <span
          className={cn(
            'font-bold tracking-[-0.02em] text-paper-50',
            lg ? 'text-2xl' : 'text-[19px]'
          )}
        >
          auto
        </span>
        <span
          className={cn(
            'font-display font-semibold italic text-ember-400',
            lg ? 'text-2xl' : 'text-[19px]'
          )}
        >
          ·swe
        </span>
      </span>
    </span>
  );
}

/**
 * The soft glow and faint grid behind the auth screens. Decorative only, and
 * positioned against the nearest `relative` ancestor.
 */
export function AuthBackdrop({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0', className)}>
      <div className="absolute inset-0 bg-radial-[circle_at_50%_0%] from-ember-400/14 to-transparent to-60%" />
      <div className="absolute inset-0 bg-radial-[circle_at_100%_100%] from-dust-400/8 to-transparent to-50%" />
      <div
        className="absolute inset-0 opacity-[0.05] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]"
        style={{
          backgroundImage:
            'linear-gradient(to right, var(--color-paper-500) 1px, transparent 1px),' +
            'linear-gradient(to bottom, var(--color-paper-500) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
    </div>
  );
}

/**
 * The chromeless ground the sign-in screens share: the brand mark above a
 * centred card on a softly lit page. `login` places it in the right half of its
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
      {!embedded && <AuthBackdrop />}
      <div className={cn('relative w-full', embedded ? 'max-w-[460px]' : 'max-w-[420px]')}>
        {!embedded && (
          <div className={cn('mb-8 flex justify-center', brand === 'mobile' && 'lg:hidden')}>
            <BrandMark />
          </div>
        )}
        <Card className="rounded-2xl p-6 sm:p-8">{children}</Card>
        {footer && (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[13px] text-paper-500">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

type HeadingTone = 'ember' | 'moss' | 'amber' | 'brick';

const TONE_TEXT: Record<HeadingTone, string> = {
  amber: 'text-amber-400',
  brick: 'text-brick-400',
  ember: 'text-ember-300',
  moss: 'text-moss-400',
};

const TONE_CHIP: Record<HeadingTone, string> = {
  amber: 'border-amber-400/30 bg-amber-400/10 text-amber-400',
  brick: 'border-brick-400/30 bg-brick-400/10 text-brick-400',
  ember: 'border-ember-400/30 bg-ember-400/10 text-ember-300',
  moss: 'border-moss-400/30 bg-moss-400/10 text-moss-400',
};

/**
 * The opening of every auth card: an optional status icon, an eyebrow, the
 * heading, and a lede. The icon and eyebrow take `tone`, so a success or
 * pending screen reads as such before a word of it is read — and the words
 * still say it, so the state is never colour alone.
 */
export function AuthHeading({
  children,
  icon,
  kicker,
  kickerTone = 'ember',
  title,
}: {
  /** Lede under the heading. */
  children?: ReactNode;
  icon?: IconName;
  kicker?: string;
  kickerTone?: HeadingTone;
  title: string;
}) {
  return (
    <div className="mb-6">
      {icon && (
        <div
          aria-hidden="true"
          className={cn(
            'mb-4 flex h-11 w-11 items-center justify-center rounded-xl border',
            TONE_CHIP[kickerTone]
          )}
        >
          <Icon name={icon} size={20} />
        </div>
      )}
      {kicker && <div className={cn('kicker mb-1.5', TONE_TEXT[kickerTone])}>{kicker}</div>}
      <h1 className="text-2xl font-semibold tracking-[-0.02em] text-paper-50">{title}</h1>
      {children && <div className="mt-2 text-sm leading-relaxed text-paper-400">{children}</div>}
    </div>
  );
}
