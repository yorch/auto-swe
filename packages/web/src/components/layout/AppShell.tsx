'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssistantPanel } from '@/components/assistant/AssistantPanel';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { DetailBackLink } from '@/components/layout/DetailBackLink';
import { PageContainer } from '@/components/layout/PageContainer';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { TourHost } from '@/components/tour/TourHost';
import { useApprovalsStream } from '@/hooks/useApprovals';
import { usePageViewEvents } from '@/hooks/usePageViewEvents';
import { cn } from '@/lib/utils';
import { useSidebarStore } from '@/stores/sidebarStore';

// Public routes (mirrors the page entries in proxy.ts PUBLIC_PATHS). They render
// without the app chrome, whose queries would 401 for a signed-out visitor.
const CHROMELESS_ROUTES = ['/login', '/reset-password', '/device'];

// Routes that manage their own full-height layout: the shell gives them the whole main area (no
// padding, no page scroll) and the page decides what scrolls. Each pattern is one named entry, so
// a URL change is a one-line edit here (and in AppShell.test.tsx).
const FULLSCREEN_ROUTES: Record<string, RegExp> = {
  runDetail: /^\/runs\/[^/]+$/,
  templateDiff: /^\/library\/[^/]+\/diff/,
  // The template detail page hosts the visual editor, which fills the viewport height. Exactly one
  // segment after the library: its analytics/runs/diff sub-pages are ordinary scrolling pages.
  templateEditor: /^\/library\/[^/]+\/?$/,
};

export function isFullscreenRoute(pathname: string): boolean {
  return Object.values(FULLSCREEN_ROUTES).some((re) => re.test(pathname));
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isChromeless = CHROMELESS_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  if (isChromeless) {
    return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
  }

  const fullscreen = isFullscreenRoute(pathname);

  return <Chrome fullscreen={fullscreen}>{children}</Chrome>;
}

// Split out so the inbox stream only mounts (and its hook only runs) on
// chromed routes — a hook cannot sit behind the early return above.
function Chrome({ children, fullscreen }: { children: React.ReactNode; fullscreen: boolean }) {
  useApprovalsStream();
  const pathname = usePathname();
  usePageViewEvents(pathname);
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggle = useSidebarStore((s) => s.toggle);
  const sync = useSidebarStore((s) => s.sync);
  const [expandedVisit, setExpandedVisit] = useState<string | null>(null);
  const visitExpanded = expandedVisit === pathname;
  const rail = fullscreen ? !visitExpanded : collapsed;
  useEffect(() => {
    sync();
    const onStorage = () => sync();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [sync]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new route starts a new focused visit.
  useEffect(() => setExpandedVisit(null), [pathname]);
  const { navOpen, openNav, closeNav, menuButtonRef, closeButtonRef } = useNavDrawer(pathname);

  return (
    <>
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-accent-500 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        href="#main-content"
      >
        Skip to content
      </a>
      <div
        className="grid h-dvh grid-cols-1 overflow-hidden text-paper-200 [grid-auto-rows:minmax(0,1fr)]"
        data-focused={fullscreen ? (visitExpanded ? 'expanded' : 'collapsed') : 'ordinary'}
        data-sidebar-shell
      >
        <Sidebar
          closeButtonRef={closeButtonRef}
          collapsed={rail}
          onClose={closeNav}
          onToggle={() =>
            fullscreen ? setExpandedVisit(visitExpanded ? null : pathname) : toggle()
          }
          open={navOpen}
        />
        {navOpen && (
          // Backdrop for the mobile drawer; a click outside the drawer closes it.
          <div
            aria-hidden="true"
            className={cn('fixed inset-0 z-30 bg-scrim md:hidden')}
            onClick={closeNav}
          />
        )}
        {/* While the drawer is open the page behind it is
          inert: screen readers cannot wander into it and nothing in it takes
          focus or clicks — the Tab trap below is only the keyboard half. */}
        <div className="flex min-w-0 flex-col overflow-hidden" inert={navOpen}>
          <TopBar menuButtonRef={menuButtonRef} navOpen={navOpen} onOpenNav={openNav} />
          {/* The boundary sits inside <main>, keyed by route: a page crash leaves the
            shell standing, and navigating away clears it. */}
          {fullscreen ? (
            <main
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none"
              id="main-content"
              tabIndex={-1}
            >
              <DetailBackLink focused />
              <div className="min-h-0 flex-1">
                <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
              </div>
            </main>
          ) : (
            <main
              className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
              id="main-content"
              tabIndex={-1}
            >
              <PageContainer>
                {!pathname.startsWith('/admin/') && <DetailBackLink />}
                <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
              </PageContainer>
            </main>
          )}
        </div>
      </div>
      <TourHost />
      <AssistantPanel />
    </>
  );
}

const MD_QUERY = '(min-width: 768px)';

/**
 * The navigation drawer: open/close state plus the keyboard and focus
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
      // The product tour card lives outside the drawer and the inert page; Tab inside it must
      // reach its buttons rather than be pulled back into the drawer.
      if (document.activeElement?.closest('[data-tour-card]')) {
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
