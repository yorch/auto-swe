import type { Metadata } from 'next';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import './globals.css';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppShell } from '@/components/layout/AppShell';
import { Providers } from '@/components/Providers';

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
  title: 'Conductor',
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
    <html className={`${inter.variable} ${ibmPlexMono.variable}`} lang="en">
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: operator-controlled env vars only */}
        <script dangerouslySetInnerHTML={{ __html: `window.__APP_CONFIG__=${appConfig};` }} />
        <style>{`
          :root {
            --font-display: var(--font-inter), 'Inter', -apple-system, sans-serif;
            --font-mono: var(--font-ibm-plex-mono), 'IBM Plex Mono', ui-monospace, monospace;
          }
        `}</style>
      </head>
      <body className="min-h-screen">
        <Providers>
          <ErrorBoundary>
            <AppShell>{children}</AppShell>
          </ErrorBoundary>
        </Providers>
      </body>
    </html>
  );
}
