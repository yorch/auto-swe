/**
 * Inline SVG icons for in-app actions.
 *
 * The app ships its own icons as inline `<svg>` (no icon library — see
 * `Sidebar.tsx`). Each icon draws on a 24×24 grid and inherits color via
 * `currentColor`, so it picks up the surrounding text/button color. Keep new
 * icons here so action buttons share one source of truth instead of pasting
 * raw `<svg>` into pages.
 */

import { cn } from '@/lib/utils';

type IconProps = {
  className?: string;
  /** Square edge length in px (default 14, sized for `Button size="sm"`). */
  size?: number;
};

/**
 * AI sparkle — a large four-point star with a small companion. Marks
 * generative actions ("Generate with AI"). Filled, since stars read better
 * solid than stroked at button size.
 */
export function SparkleIcon({ className, size = 14 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn('shrink-0', className)}
      fill="currentColor"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M11.5 2.5l1.85 4.9 4.9 1.85-4.9 1.85L11.5 16l-1.85-4.9L4.75 9.25l4.9-1.85z" />
      <path d="M18.5 14l.85 2.15L21.5 17l-2.15.85L18.5 20l-.85-2.15L15.5 17l2.15-.85z" />
    </svg>
  );
}

/**
 * AI explanation — a sparkle above stacked text lines. Marks the inverse of
 * authoring ("Explain": turn a spec into a plain-language walkthrough).
 */
export function SparkleTextIcon({ className, size = 14 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn('shrink-0', className)}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4 9h8M4 13h11M4 17h7" />
      <path
        d="M18 3l.8 2.2 2.2.8-2.2.8L18 9l-.8-2.2L15 6l2.2-.8z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}
