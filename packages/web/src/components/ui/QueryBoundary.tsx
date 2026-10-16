import type { ReactNode } from 'react';
import { errMsg } from '@/lib/errors';
import { Alert } from './Alert';
import { Button } from './Button';
import { SkeletonFor, type SkeletonShape } from './LoadingState';

interface QueryBoundaryProps {
  isLoading: boolean;
  isError?: boolean;
  /** True while a refetch is running; the Retry button disables and says so. */
  isFetching?: boolean;
  error?: unknown;
  /** Shape of the skeleton shown while loading; match what `children` will render. Default `rows`. */
  shape?: SkeletonShape;
  /** Placeholder count: rows, cards or form fields (ignored by `detail`). */
  rows?: number;
  /** Replaces the shaped skeleton for a layout none of the shapes fits; give it `role="status"`. */
  loading?: ReactNode;
  /**
   * What is being loaded. Names the skeleton for screen readers ("Loading teams")
   * and the error alert ("Could not load teams: …").
   */
  label?: string;
  /** Re-runs the failed query; shows a Retry button on the error alert. */
  onRetry?: () => void;
  children?: ReactNode;
}

/**
 * The three states every list page shares: a skeleton shaped like the content while the
 * query is in flight, an error alert when it failed, and `children` once it
 * settled. Pages that only checked `isLoading` rendered their empty state on a
 * 403 or 500 — `data` is simply undefined then — so route every list query's
 * `isError` / `error` through here.
 */
export function QueryBoundary({
  children,
  error,
  isError = false,
  isFetching = false,
  isLoading,
  label,
  loading,
  rows,
  shape = 'rows',
  onRetry,
}: QueryBoundaryProps) {
  if (isLoading) {
    return loading ?? <SkeletonFor label={label} rows={rows} shape={shape} />;
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
