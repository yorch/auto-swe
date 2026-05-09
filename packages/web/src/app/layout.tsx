import type { Metadata } from 'next';
import './globals.css';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { Providers } from '@/components/Providers';

export const metadata: Metadata = {
  title: 'auto-swe | Engineering Automation',
  description: 'AI-powered software engineering automation dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--background)]">
        <Providers>
          <ErrorBoundary>
            <div className="flex h-screen">
              <Sidebar />
              <div className="flex flex-col flex-1 overflow-hidden">
                <TopBar />
                <main className="flex-1 overflow-y-auto p-6">{children}</main>
              </div>
            </div>
          </ErrorBoundary>
        </Providers>
      </body>
    </html>
  );
}
