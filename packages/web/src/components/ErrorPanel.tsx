'use client';

import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

/**
 * The page-level crash screen, shared by the in-shell `ErrorBoundary` and the
 * route `error.tsx`. The heading and actions are the same whatever threw; the
 * raw message sits in a collapsed details block, there for a bug report but out
 * of the way of someone who only wants to get back to work.
 */
export function ErrorPanel({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md text-center" role="alert">
        <div
          aria-hidden="true"
          className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-brick-400/30 bg-brick-400/10 text-brick-400"
        >
          <Icon name="warning" size={26} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-paper-50">Something went wrong</h1>
        <p className="mt-2 text-sm leading-relaxed text-paper-400">
          This page hit an unexpected error. Your work elsewhere is not affected — try again, or
          reload the page.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <Button onClick={onRetry} variant="primary">
              <Icon name="refresh" size={14} />
              Try again
            </Button>
          )}
          <Button
            onClick={() => window.location.reload()}
            variant={onRetry ? 'secondary' : 'primary'}
          >
            Reload page
          </Button>
          <ButtonLink href="/" variant="ghost">
            Go home
          </ButtonLink>
        </div>
        {error?.message && (
          <details className="mt-8 rounded-lg border border-ink-500/70 bg-ink-900/60 text-left">
            <summary className="cursor-pointer select-none px-3.5 py-2.5 text-[13px] text-paper-400 hover:text-paper-200">
              Error details
            </summary>
            <pre className="max-h-48 overflow-auto border-t border-ink-600 px-3.5 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-paper-300">
              {error.message}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
