import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The chromeless ground the sign-in screens share: a narrow column centred on
 * the page background. `login` places it in the right half of its split
 * layout; the single-panel screens (reset password, awaiting approval) fill
 * the viewport with it.
 */
export function AuthLayout({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn('flex min-h-dvh items-center justify-center bg-ink-800 px-6 py-12', className)}
    >
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

type KickerTone = 'ember' | 'moss' | 'amber';

const KICKER_TONE: Record<KickerTone, string> = {
  amber: 'text-amber-400',
  ember: 'text-ember-400',
  moss: 'text-moss-400',
};

/** The kicker + display heading + lede every auth screen opens with. */
export function AuthHeading({
  children,
  kicker,
  kickerTone = 'ember',
  title,
}: {
  /** Lede under the heading. */
  children?: ReactNode;
  kicker?: string;
  kickerTone?: KickerTone;
  title: string;
}) {
  return (
    <>
      {kicker && (
        <div
          className={cn(
            'mb-2 font-mono text-[10px] uppercase tracking-[0.24em]',
            KICKER_TONE[kickerTone]
          )}
        >
          {kicker}
        </div>
      )}
      <h1
        className={cn(
          'font-display text-4xl font-light tracking-tight text-paper-50',
          children ? 'mb-3' : 'mb-8'
        )}
      >
        {title}
      </h1>
      {children}
    </>
  );
}
