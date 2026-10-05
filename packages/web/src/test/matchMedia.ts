import { vi } from 'vitest';

/**
 * A controllable `window.matchMedia` for jsdom, which has none. `setViewportWidth` re-evaluates
 * every `(min-width: Npx)` / `(max-width: Npx)` query it has handed out and fires `change` on
 * the ones whose answer flipped, as a browser does when the window is resized.
 */
export function mockViewport(initialWidth: number) {
  let width = initialWidth;
  interface Entry {
    query: string;
    listeners: Set<() => void>;
    last: boolean;
  }
  const entries: Entry[] = [];

  const evaluate = (query: string): boolean => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
    return (min ? width >= Number(min[1]) : true) && (max ? width <= Number(max[1]) : true);
  };

  window.matchMedia = vi.fn((query: string) => {
    const entry: Entry = { last: evaluate(query), listeners: new Set(), query };
    entries.push(entry);
    return {
      addEventListener: (_: string, cb: () => void) => entry.listeners.add(cb),
      get matches() {
        return evaluate(query);
      },
      media: query,
      removeEventListener: (_: string, cb: () => void) => entry.listeners.delete(cb),
    } as unknown as MediaQueryList;
  }) as unknown as typeof window.matchMedia;

  return {
    setViewportWidth(next: number) {
      width = next;
      for (const e of entries) {
        const now = evaluate(e.query);
        if (now !== e.last) {
          e.last = now;
          for (const cb of [...e.listeners]) {
            cb();
          }
        }
      }
    },
  };
}

/** Remove the mock so a later test sees a browser without `matchMedia`. */
export function clearViewport() {
  // biome-ignore lint/suspicious/noExplicitAny: jsdom does not declare matchMedia
  (window as any).matchMedia = undefined;
}
