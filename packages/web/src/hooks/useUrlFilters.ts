'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * Filter state kept in the address bar so a filtered list can be bookmarked,
 * shared and survives a reload. `update` replaces the entry (no history spam);
 * a null or empty value removes the parameter. Callers render inside Suspense.
 */
export function useUrlFilters() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const update = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(patch)) {
        if (value) {
          next.set(key, value);
        } else {
          next.delete(key);
        }
      }
      router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
    },
    [params, pathname, router]
  );
  return { params, update };
}

/** A non-negative integer offset from a raw parameter; anything else is 0. */
export function parseOffset(raw: string | null): number {
  const value = Number(raw ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
