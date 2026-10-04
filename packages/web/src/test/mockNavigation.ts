import { useSyncExternalStore } from 'react';

/**
 * A reactive stand-in for `next/navigation` in page tests: `router.replace`
 * rewrites the query string and re-renders whatever read `useSearchParams`, so a
 * URL-synced filter can be driven end to end.
 *
 *   vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
 */
export const nav = {
  listeners: new Set<() => void>(),
  pathname: '/',
  replace: [] as string[],
  search: '',
};

export function resetNavigation(search = '', pathname = '/') {
  nav.search = search;
  nav.pathname = pathname;
  nav.replace = [];
}

export function navigationMock() {
  return {
    usePathname: () => nav.pathname,
    useRouter: () => ({
      replace: (url: string) => {
        nav.replace.push(url);
        nav.search = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        for (const l of nav.listeners) {
          l();
        }
      },
    }),
    useSearchParams: () =>
      new URLSearchParams(
        useSyncExternalStore(
          (cb) => {
            nav.listeners.add(cb);
            return () => nav.listeners.delete(cb);
          },
          () => nav.search
        )
      ),
  };
}
