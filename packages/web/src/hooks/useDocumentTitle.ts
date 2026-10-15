'use client';

import { useEffect } from 'react';
import { formatDocumentTitle, routeDocumentTitle } from '@/lib/documentTitle';

/**
 * Sets the browser tab title for a page whose title depends on loaded data.
 * Pass `null` while the data is loading — the route's title (from the root
 * layout's metadata) shows.
 *
 * Setting `document.title` once is not enough. On a client navigation Next renders
 * the new route's metadata as a new `<title>`, and React inserts it ahead of the
 * existing one, so it wins — possibly after this effect ran, since metadata
 * streams. The observer puts the page's title back whenever `<head>` changes it.
 */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) {
      return;
    }
    const wanted = formatDocumentTitle(title);
    const apply = () => {
      if (document.title !== wanted) {
        document.title = wanted;
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { characterData: true, childList: true, subtree: true });
    return () => {
      observer.disconnect();
      // Back to the route's title. Read the URL now, not at mount: when this runs
      // because of a navigation, the location is already the new route's.
      document.title = routeDocumentTitle(window.location.pathname);
    };
  }, [title]);
}
