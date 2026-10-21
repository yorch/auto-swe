'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

/** How long page views are held to be sent as one batch. */
const FLUSH_DELAY_MS = 5000;
/** The gateway accepts at most this many events per request. */
const BATCH_MAX = 20;

/** True when the browser asks not to be tracked. Checked on every send, not once. */
export function doNotTrack(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  const win = window as Window & { doNotTrack?: string };
  return (
    nav.doNotTrack === '1' ||
    nav.doNotTrack === 'yes' ||
    win.doNotTrack === '1' ||
    nav.globalPrivacyControl === true
  );
}

/** Set once the gateway says page views are off; nothing is sent for the rest of the session. */
let serverDisabled = false;
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
/** Whose views `pending` holds, so a different person signing in never inherits them. */
let owner: string | undefined;

/** For tests. */
export function resetPageViewEvents(): void {
  serverDisabled = false;
  owner = undefined;
  pending = [];
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}

async function flush(): Promise<void> {
  timer = undefined;
  const paths = pending.splice(0, BATCH_MAX);
  if (paths.length === 0 || serverDisabled || doNotTrack()) {
    pending = [];
    return;
  }
  try {
    const res = await api.post<{ enabled: boolean }>('/api/v1/activity/ui', {
      events: paths.map((route) => ({ event: 'page_view', route })),
    });
    if (!res.enabled) {
      // Off: nothing queued behind this batch is ever sent.
      serverDisabled = true;
      pending = [];
    }
  } catch {
    // Telemetry never disturbs the page: a failed batch is dropped.
  }
  if (pending.length > 0) {
    timer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
  }
}

/**
 * Report the page being viewed, batched. Sends the pathname only (no query string or fragment); the
 * gateway reduces it to a route template and keeps nothing it does not recognise. Off unless an
 * operator enabled page-view events, and silent for a browser that sends Do Not Track.
 */
export function usePageViewEvents(pathname: string): void {
  const userId = useAuthStore((s) => s.user?.sub);
  useEffect(() => {
    if (owner !== userId) {
      // A different session: drop what the last one left, and ask the gateway afresh.
      resetPageViewEvents();
      owner = userId;
    }
  }, [userId]);
  useEffect(() => {
    if (serverDisabled || doNotTrack()) {
      return;
    }
    // The same page twice in one batch is one view.
    if (!pending.includes(pathname)) {
      pending.push(pathname);
    }
    timer ??= setTimeout(() => void flush(), FLUSH_DELAY_MS);
  }, [pathname]);
}
