'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { useApprovalsStream } from '@/hooks/useApprovals';

// Public routes (mirrors the page entries in proxy.ts PUBLIC_PATHS). They render
// without the app chrome, whose queries would 401 for a signed-out visitor.
const CHROMELESS_ROUTES = ['/login', '/reset-password'];

// Run detail and template diff pages manage their own full-height layout.
function isFullscreenRoute(pathname: string): boolean {
  return /^\/runs\/[^/]+$/.test(pathname) || /^\/workflows\/library\/[^/]+\/diff/.test(pathname);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isChromeless = CHROMELESS_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  if (isChromeless) {
    return <>{children}</>;
  }

  const fullscreen = isFullscreenRoute(pathname);

  return <Chrome fullscreen={fullscreen}>{children}</Chrome>;
}

// Split out so the inbox stream only mounts (and its hook only runs) on
// chromed routes — a hook cannot sit behind the early return above.
function Chrome({ children, fullscreen }: { children: React.ReactNode; fullscreen: boolean }) {
  useApprovalsStream();
  const pathname = usePathname();
  const { navOpen, openNav, closeNav, menuButtonRef, closeButtonRef } = useNavDrawer(pathname);

  return (
    <div className="grid h-screen grid-cols-1 overflow-hidden text-paper-200 [grid-auto-rows:minmax(0,1fr)] md:grid-cols-[234px_minmax(0,1fr)]">
      <Sidebar closeButtonRef={closeButtonRef} onClose={closeNav} open={navOpen} />
      {navOpen && (
        // Backdrop for the mobile drawer; a click outside the drawer closes it.
        <div
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={closeNav}
        />
      )}
      {/* While the drawer is open (only possible below md) the page behind it is
          inert: screen readers cannot wander into it and nothing in it takes
          focus or clicks — the Tab trap below is only the keyboard half. */}
      <div className="flex min-w-0 flex-col overflow-hidden" inert={navOpen}>
        <TopBar menuButtonRef={menuButtonRef} navOpen={navOpen} onOpenNav={openNav} />
        {fullscreen ? (
          <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
        ) : (
          <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div className="mx-auto max-w-[1280px] px-4 pt-6 pb-16 md:px-10 md:pt-10">
              {children}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}

const MD_QUERY = '(min-width: 768px)';

/**
 * The mobile navigation drawer: open/close state plus the keyboard and focus
 * behaviour a modal drawer owes its users. It closes on navigation, on Escape
 * and when the viewport grows past `md` (where the sidebar is always shown);
 * opening moves focus into the drawer, closing returns it to the menu button,
 * and Tab is kept inside the drawer while it is open.
 */
function useNavDrawer(pathname: string) {
  const [navOpen, setNavOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);

  const openNav = useCallback(() => setNavOpen(true), []);
  const closeNav = useCallback(() => setNavOpen(false), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger — any navigation closes the drawer.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia(MD_QUERY);
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setNavOpen(false);
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (navOpen) {
      wasOpen.current = true;
      // Wait a frame: the drawer is `visibility: hidden` until the open
      // styles apply, and a hidden element cannot take focus.
      const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      // Reclaim focus only if it was inside the now-hidden drawer (or dropped
      // to <body>); focus the user moved elsewhere stays where it is.
      const active = document.activeElement;
      const drawer = closeButtonRef.current?.closest('aside');
      if (!active || active === document.body || drawer?.contains(active)) {
        menuButtonRef.current?.focus();
      }
    }
  }, [navOpen]);

  useEffect(() => {
    if (!navOpen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setNavOpen(false);
        return;
      }
      if (e.key !== 'Tab') {
        return;
      }
      const drawer = closeButtonRef.current?.closest('aside');
      if (!drawer) {
        return;
      }
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!drawer.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

  return { closeButtonRef, closeNav, menuButtonRef, navOpen, openNav };
}
