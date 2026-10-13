'use client';

import { useEffect, useRef, useState } from 'react';

export const URL_SEARCH_DEBOUNCE_MS = 300;

/**
 * A search box whose value lives in the address bar. The box edits a local draft;
 * after a pause `write` puts the draft (through `normalize`) into the URL.
 *
 * The draft is reset from the URL only when the URL holds something this hook did
 * not write itself: back/forward, a link, a "clear filters" button. Resyncing on
 * every URL change instead would let a write landing late overwrite whatever was
 * typed while it was in flight, and with a trimming `normalize` would eat a trailing
 * space mid-phrase ("permission " becoming "permission" before "denied" is typed).
 */
export function useDebouncedUrlSearch(
  urlValue: string,
  write: (value: string) => void,
  { delayMs = URL_SEARCH_DEBOUNCE_MS, normalize = (v: string) => v } = {}
): [string, (value: string) => void] {
  const [draft, setDraft] = useState(urlValue);
  const lastWritten = useRef(urlValue);
  // Values written and not yet seen back in the URL, oldest first. A write can
  // land after a newer one was sent, so the newest alone cannot tell it apart
  // from outside navigation.
  const inFlight = useRef<string[]>([]);
  // The latest callbacks, so a pending write uses the current URL's other filters
  // and a re-render does not restart the timer.
  const writeRef = useRef(write);
  writeRef.current = write;
  const normalizeRef = useRef(normalize);
  normalizeRef.current = normalize;

  useEffect(() => {
    const ours = inFlight.current.indexOf(urlValue);
    if (ours !== -1) {
      inFlight.current = inFlight.current.slice(ours + 1);
      return;
    }
    if (urlValue !== lastWritten.current) {
      inFlight.current = [];
      lastWritten.current = urlValue;
      setDraft(urlValue);
    }
  }, [urlValue]);

  useEffect(() => {
    const next = normalizeRef.current(draft);
    if (next === lastWritten.current) {
      return;
    }
    const timer = setTimeout(() => {
      // A clear-filters button may already have put the same value in the URL.
      if (next === lastWritten.current) {
        return;
      }
      lastWritten.current = next;
      inFlight.current.push(next);
      writeRef.current(next);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [draft, delayMs]);

  return [draft, setDraft];
}
