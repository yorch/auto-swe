import type { ReactNode } from 'react';
import { errMsg } from '@/lib/errors';
import { Alert } from './Alert';
import { Button } from './Button';
import { LoadingState } from './LoadingState';

interface QueryBoundaryProps {
  isLoading: boolean;
  isError?: boolean;
  /** True while a refetch is running; the Retry button disables and says so. */
  isFetching?: boolean;
  error?: unknown;
  /** Rendered while loading instead of the spinner — e.g. `<SkeletonRows />` shaped like the list. */
  loading?: ReactNode;
  /** Caption for the loading indicator. */
  loadingMessage?: string;
  /** One-line loading indicator, for a section inside a card rather than a whole page. */
  compact?: boolean;
  /** What was being loaded, for the error alert — "Could not load teams: …". */
  label?: string;
  /** Re-runs the failed query; shows a Retry button on the error alert. */
  onRetry?: () => void;
  children?: ReactNode;
}

/**
 * The three states every list page shares: a loading indicator while the
 * query is in flight, an error alert when it failed, and `children` once it
 * settled. Pages that only checked `isLoading` rendered their empty state on a
 * 403 or 500 — `data` is simply undefined then — so route every list query's
 * `isError` / `error` through here.
 */
export function QueryBoundary({
  children,
  compact = false,
  error,
  isError = false,
  isFetching = false,
  isLoading,
  label,
  loading,
  loadingMessage,
  onRetry,
}: QueryBoundaryProps) {
  if (isLoading) {
    return loading ?? <LoadingState compact={compact} message={loadingMessage} />;
  }
  if (isError) {
    const detail = errMsg(error, 'request failed');
    return (
      <Alert variant="error">
        <span className="flex flex-wrap items-center justify-between gap-3">
          <span>{label ? `Could not load ${label}: ${detail}` : detail}</span>
          {onRetry && (
            <Button disabled={isFetching} onClick={onRetry} size="sm">
              {isFetching ? 'Retrying…' : 'Retry'}
            </Button>
          )}
        </span>
      </Alert>
    );
  }
  return <>{children}</>;
}
