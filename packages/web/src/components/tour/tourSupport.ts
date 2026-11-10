import { focusMainContent } from '@/lib/dismissed';

/** The "tour seen" flag, kept with the other per-viewer flags in `lib/dismissed.ts`. */
export const TOUR_SEEN_KEY = 'product-tour';

/** The first link or button of the sidebar drawer, when it is outside any inert region. */
function focusOpenDrawer(): void {
  const drawer = document.querySelector<HTMLElement>('[data-tour="sidebar"]');
  if (!drawer || drawer.closest('[inert]')) {
    return;
  }
  drawer
    .querySelector<HTMLElement>('a[href], button:not([disabled])')
    ?.focus({ preventScroll: true });
}

/**
 * Put focus back where a tour was started. A focus call can be a silent no-op: with the mobile
 * menu open the whole page, opener and main region included, is `inert`. Each call is checked,
 * and the open drawer, which sits outside the inert page, is the last resort.
 */
export function restoreTourFocus(opener: HTMLElement | null): void {
  if (opener?.isConnected) {
    opener.focus();
    if (document.activeElement === opener) {
      return;
    }
  }
  focusMainContent();
  const main = document.getElementById('main-content');
  if (main && document.activeElement === main) {
    return;
  }
  focusOpenDrawer();
}
