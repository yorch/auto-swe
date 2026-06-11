import type { Metadata } from 'next';
import { Bodoni_Moda, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppShell } from '@/components/layout/AppShell';
import { Providers } from '@/components/Providers';

const bodoniModa = Bodoni_Moda({
  axes: ['opsz'],
  display: 'swap',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  variable: '--font-bodoni',
  weight: ['400', '500', '600', '700'],
});

const ibmPlexMono = IBM_Plex_Mono({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-ibm-plex-mono',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  description: 'Engineering automation control plane',
  title: 'auto-swe',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const appConfig = JSON.stringify({
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
    temporalUiUrl:
      process.env.NEXT_PUBLIC_TEMPORAL_UI_URL ??
      (process.env.NODE_ENV !== 'production' ? 'http://localhost:8233' : ''),
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  return (
    <html className={`${bodoniModa.variable} ${ibmPlexMono.variable}`} lang="en">
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: operator-controlled env vars only */}
        <script dangerouslySetInnerHTML={{ __html: `window.__APP_CONFIG__=${appConfig};` }} />
        <style>{`
          :root {
            --font-display: var(--font-bodoni), 'Bodoni Moda', Georgia, serif;
            --font-mono: var(--font-ibm-plex-mono), 'IBM Plex Mono', ui-monospace, monospace;
          }
        `}</style>
      </head>
      <body className="min-h-screen">
        {/* Film grain overlay — fixed full-screen, above all content */}
        <div
          aria-hidden="true"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
            backgroundRepeat: 'repeat',
            inset: 0,
            mixBlendMode: 'overlay',
            opacity: 0.04,
            pointerEvents: 'none',
            position: 'fixed',
            zIndex: 9999,
          }}
        />
        <Providers>
          <ErrorBoundary>
            <AppShell>{children}</AppShell>
          </ErrorBoundary>
        </Providers>
      </body>
    </html>
  );
}
