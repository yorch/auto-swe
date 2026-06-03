import type { Metadata } from 'next';
import { Fraunces, IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppShell } from '@/components/layout/AppShell';
import { Providers } from '@/components/Providers';

const fraunces = Fraunces({
  axes: ['SOFT', 'WONK', 'opsz'],
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-fraunces',
});

const plex = IBM_Plex_Sans({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-plex',
  weight: ['300', '400', '500', '600'],
});

const jetbrains = JetBrains_Mono({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-jetbrains',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  description: 'Engineering automation control plane',
  title: 'auto-swe',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Server Component: process.env is read from the Node.js runtime at request
  // time, not baked at build. Injecting here lets client-side config.ts pick up
  // values set via docker -e / docker-compose environment: without a rebuild.
  // Unicode-escape <, >, & so the JSON is safe inside a <script> tag even if
  // an env var contained a literal </script> sequence (same technique Next.js
  // uses for __NEXT_DATA__).
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
    <html className={`${fraunces.variable} ${plex.variable} ${jetbrains.variable}`} lang="en">
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: operator-controlled env vars only */}
        <script dangerouslySetInnerHTML={{ __html: `window.__APP_CONFIG__=${appConfig};` }} />
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
