import type { Metadata } from 'next';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import './globals.css';
import { AppConfigScript, InlineHeadScript } from '@/components/AppConfigScript';
import { AppShell } from '@/components/layout/AppShell';
import { Providers } from '@/components/Providers';
import { ThemeSync } from '@/components/ThemeSync';
import { publicApiUrl, temporalUiUrl } from '@/lib/env';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

const inter = Inter({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['400', '500', '600', '700'],
});

const ibmPlexMono = IBM_Plex_Mono({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-ibm-plex-mono',
  weight: ['400', '500', '600'],
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
