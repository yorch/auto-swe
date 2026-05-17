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
  return (
    <html className={`${fraunces.variable} ${plex.variable} ${jetbrains.variable}`} lang="en">
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
