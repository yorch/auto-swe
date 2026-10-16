'use client';

import { type Tokens, tokensFor } from '@/lib/palette';
import { useThemeStore } from '@/stores/themeStore';

/**
 * The literal palette for the painted theme and palette, for the few surfaces that
 * cannot use `var(--color-*)` (SVG presentation attributes in charts and the workflow
 * canvas; see `lib/palette.ts`). Everything else should use Tailwind classes or `var()`.
 */
export function useTokens(): Tokens {
  return useThemeStore((s) => tokensFor(s.resolved, s.palette));
}
