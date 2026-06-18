'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';

const CHROMELESS_ROUTES = ['/login'];

// Run detail and template diff pages manage their own full-height layout.
function isFullscreenRoute(pathname: string): boolean {
  return /^\/runs\/[^/]+$/.test(pathname) || /^\/templates\/[^/]+\/diff/.test(pathname);
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

  return (
    <div
      className="h-screen overflow-hidden text-paper-200"
      style={{ display: 'grid', gridAutoRows: 'minmax(0, 1fr)', gridTemplateColumns: '234px 1fr' }}
    >
      <Sidebar />
      <div className="flex flex-col overflow-hidden">
        <TopBar />
        {fullscreen ? (
          <main className="flex-1 overflow-hidden">{children}</main>
        ) : (
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1280px] px-10 pt-10 pb-16">{children}</div>
          </main>
        )}
      </div>
    </div>
  );
}
