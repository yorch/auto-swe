'use client';

import { useEffect, useState } from 'react';
import { TEMPORAL_UI_URL } from '@/lib/config';

/**
 * The Temporal UI base URL, or '' when none is configured.
 *
 * Read after mount: the runtime value lives on `window.__APP_CONFIG__`, which
 * does not exist during SSR, so reading it during render would hydrate a
 * different href than the server sent.
 */
export function useTemporalUiUrl(): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    setUrl(TEMPORAL_UI_URL);
  }, []);
  return url;
}

/**
 * Deep link to one workflow's history, or null without a configured UI. The
 * worker and gateway both run in the `default` namespace.
 */
export function useTemporalWorkflowUrl(workflowId: string): string | null {
  const base = useTemporalUiUrl();
  if (!base) {
    return null;
  }
  return `${base.replace(/\/$/, '')}/namespaces/default/workflows/${encodeURIComponent(workflowId)}`;
}
