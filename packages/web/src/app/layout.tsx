import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { headers } from 'next/headers';
import './globals.css';
import { AppConfigScript, InlineHeadScript } from '@/components/AppConfigScript';
import { AppShell } from '@/components/layout/AppShell';
import { Providers } from '@/components/Providers';
import { ThemeSync } from '@/components/ThemeSync';
import { PATHNAME_HEADER } from '@/lib/config';
import { routeDocumentTitle } from '@/lib/documentTitle';
import { publicApiUrl, temporalUiUrl } from '@/lib/env';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

// Served from the repository, not fetched from Google Fonts at build time: a
// failed download there fails `next build`. Latin subsets of the variable builds;
// licences beside the files (SIL Open Font License 1.1).
// Inter 4.1: weight and optical-size axes, with stylistic alternates.
const inter = localFont({
  display: 'swap',
  src: [
    { path: './fonts/inter-4-latin-variable.woff2', style: 'normal', weight: '100 900' },
    { path: './fonts/inter-4-latin-variable-italic.woff2', style: 'italic', weight: '100 900' },
  ],
  variable: '--font-inter',
});

const jetbrainsMono = localFont({
  display: 'swap',
  src: [
    { path: './fonts/jetbrains-mono-latin-variable.woff2', style: 'normal', weight: '100 800' },
  ],
  variable: '--font-jetbrains-mono',
});

// The tab title comes from here, per route, rather than from an effect in the browser:
// Next renders a new `<title>` from metadata on every navigation, and that element
// beats anything an effect wrote into the old one. The proxy forwards the pathname
// because a layout cannot see the URL. Pages with data-dependent titles refine it
// client-side with `useDocumentTitle`.
export async function generateMetadata(): Promise<Metadata> {
  const pathname = (await headers()).get(PATHNAME_HEADER);
  return {
    description: 'Durable agent workflow platform',
    title: { default: routeDocumentTitle(pathname), template: '%s · auto·swe' },
  };
}

// Render per request. The layout injects NEXT_PUBLIC_API_URL / NEXT_PUBLIC_TEMPORAL_UI_URL into
// window.__APP_CONFIG__ from the running container's environment. Left static, Next prerenders
// it during `next build` — where neither is set — and bakes the localhost fallbacks into every
// page, so the published image can only ever talk to a gateway on localhost:8080.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const appConfig = JSON.stringify({
    apiUrl: publicApiUrl(),
    temporalUiUrl: temporalUiUrl(),
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  return (
    <html
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      <head suppressHydrationWarning>
        {/* Applies the saved theme before first paint, so a light-theme user never sees a dark flash. */}
        <InlineHeadScript id="__THEME__" source={THEME_INIT_SCRIPT} />
        <AppConfigScript appConfig={appConfig} />
        <style>{`
          :root {
            --font-display: var(--font-inter), 'Inter', -apple-system, sans-serif;
            --font-sans: var(--font-inter), 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            --font-mono: var(--font-jetbrains-mono), 'JetBrains Mono', ui-monospace, monospace;
          }
        `}</style>
      </head>
      <body className="min-h-dvh">
        <ThemeSync />
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
