import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { AppConfigScript, InlineHeadScript } from '@/components/AppConfigScript';
import { AppShell } from '@/components/layout/AppShell';
import { Providers } from '@/components/Providers';
import { ThemeSync } from '@/components/ThemeSync';
import { publicApiUrl, temporalUiUrl } from '@/lib/env';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

// Served from the repository, not fetched from Google Fonts at build time: a
// failed download there fails `next build`. Latin subset, from Fontsource;
// licences beside the files.
const inter = localFont({
  display: 'swap',
  src: [{ path: './fonts/inter-latin-wght-normal.woff2', style: 'normal', weight: '400 700' }],
  variable: '--font-inter',
});

const ibmPlexMono = localFont({
  display: 'swap',
  src: [
    { path: './fonts/ibm-plex-mono-latin-400-normal.woff2', style: 'normal', weight: '400' },
    { path: './fonts/ibm-plex-mono-latin-500-normal.woff2', style: 'normal', weight: '500' },
    { path: './fonts/ibm-plex-mono-latin-600-normal.woff2', style: 'normal', weight: '600' },
  ],
  variable: '--font-ibm-plex-mono',
});

export const metadata: Metadata = {
  description: 'Durable agent workflow platform',
  title: { default: 'auto·swe', template: '%s · auto·swe' },
};

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
      className={`${inter.variable} ${ibmPlexMono.variable}`}
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
            --font-mono: var(--font-ibm-plex-mono), 'IBM Plex Mono', ui-monospace, monospace;
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
