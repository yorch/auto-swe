import type { ReactNode } from 'react';
import { errMsg } from '@/lib/errors';
import { Alert } from './Alert';
import { LoadingState } from './LoadingState';

interface QueryBoundaryProps {
  isLoading: boolean;
  isError?: boolean;
  error?: unknown;
  /** Caption for the loading indicator. */
  loadingMessage?: string;
  /** What was being loaded, for the error alert — "Could not load teams: …". */
  label?: string;
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
  error,
  isError = false,
  isLoading,
  label,
  loadingMessage,
}: QueryBoundaryProps) {
  if (isLoading) {
    return <LoadingState message={loadingMessage} />;
  }
  if (isError) {
    const detail = errMsg(error, 'request failed');
    return <Alert variant="error">{label ? `Could not load ${label}: ${detail}` : detail}</Alert>;
  }
  return <>{children}</>;
}
