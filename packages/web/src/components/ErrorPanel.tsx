'use client';

import { Button, ButtonLink } from '@/components/ui/Button';

/**
 * The page-level crash screen, shared by the in-shell `ErrorBoundary` and the
 * route `error.tsx`. The raw message is shown only as a small detail line; the
 * heading and actions are the same whatever threw.
 */
export function ErrorPanel({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  return (
    <div className="flex min-h-[400px] items-center justify-center p-6 md:p-8">
      <div className="max-w-md text-center" role="alert">
        <h1 className="mb-2 text-xl font-semibold text-paper-100">Something went wrong</h1>
        <p className="mb-1 text-sm text-paper-400">
          This page hit an unexpected error. Your work elsewhere is not affected.
        </p>
        {error?.message && (
          <p className="mb-4 break-words text-xs text-paper-500">{error.message}</p>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {onRetry && <Button onClick={onRetry}>Try again</Button>}
          <Button onClick={() => window.location.reload()} variant="primary">
            Reload page
          </Button>
          <ButtonLink href="/" variant="ghost">
            Go home
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
