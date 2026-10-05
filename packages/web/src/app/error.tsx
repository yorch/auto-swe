'use client';

import { useEffect } from 'react';
import { ErrorPanel } from '@/components/ErrorPanel';

// Route-segment boundary: renders inside the root layout, so the shell survives.
export default function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error('[route error]', error);
  }, [error]);
  return <ErrorPanel error={error} onRetry={reset} />;
}
