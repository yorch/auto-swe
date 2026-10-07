'use client';

import { TOKEN, TOKEN_LIGHT, type Tokens } from '@/lib/palette';
import { useThemeStore } from '@/stores/themeStore';

/**
 * The literal palette for the painted theme, for the few surfaces that cannot use
 * `var(--color-*)` (SVG presentation attributes in charts and the workflow canvas;
 * see `lib/palette.ts`). Everything else should use Tailwind classes or `var()`.
 */
export function useTokens(): Tokens {
  return useThemeStore((s) => (s.resolved === 'light' ? TOKEN_LIGHT : TOKEN));
}
