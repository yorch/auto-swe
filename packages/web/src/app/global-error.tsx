'use client';

import { useEffect, useState } from 'react';
import type { SupportInfo } from '@/lib/env';

// Replaces the root layout when it itself throws, so it renders its own <html>
// and cannot rely on the app's providers or stylesheet: styles are inline, and
// every colour is a design token's value from globals.css, named after it.
const INK_800 = '#0e111a';
const INK_900 = '#0c0f17';
const INK_400 = '#2f3850';
const PAPER_50 = '#f7f8fb';
const PAPER_400 = '#bac1d1';
const ACCENT_500 = '#6a5bff';
const DANGER_400 = '#ff7a7a';

/** Best effort: this screen replaces the root layout, so the config script may be missing, and
 *  nothing here may throw. Only well-typed strings are kept; links must be https. */
function readSupport(): SupportInfo | undefined {
  try {
    return sanitiseSupport(
      (window as unknown as { __APP_CONFIG__?: { support?: unknown } }).__APP_CONFIG__?.support
    );
  } catch {
    return undefined;
  }
}

function sanitiseSupport(raw: unknown): SupportInfo | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const { url, email, slack } = raw as Record<string, unknown>;
  const https = (v: unknown): v is string => typeof v === 'string' && v.startsWith('https://');
  const info: SupportInfo = {};
  if (https(url)) {
    info.url = url;
  }
  if (typeof email === 'string' && email.split('@').length === 2) {
    info.email = email;
  }
  if (typeof slack === 'object' && slack !== null) {
    const { text, href } = slack as Record<string, unknown>;
    if (typeof text === 'string') {
      info.slack = https(href) ? { href, text } : { text };
    }
  }
  return info.url || info.email || info.slack ? info : undefined;
}

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  // After mount, so the server-rendered markup and the first client render agree.
  const [support, setSupport] = useState<SupportInfo | undefined>(undefined);
  useEffect(() => {
    setSupport(readSupport());
  }, []);
  const visuallyHidden = {
    clip: 'rect(0 0 0 0)',
    height: 1,
    overflow: 'hidden',
    position: 'absolute',
    whiteSpace: 'nowrap',
    width: 1,
  } as const;
  const supportLink = { color: PAPER_400, textDecoration: 'underline' } as const;
  const button = {
    alignItems: 'center',
    border: '1px solid transparent',
    borderRadius: 8,
    cursor: 'pointer',
    display: 'inline-flex',
    font: 'inherit',
    fontSize: 14,
    fontWeight: 500,
    height: 36,
    padding: '0 16px',
    textDecoration: 'none',
  } as const;
  return (
    <html lang="en">
      <body
        style={{
          alignItems: 'center',
          background: INK_800,
          color: PAPER_50,
          display: 'flex',
          fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
          justifyContent: 'center',
          margin: 0,
          minHeight: '100vh',
          textAlign: 'center',
        }}
      >
        <main
          style={{
            background: INK_900,
            border: `1px solid ${INK_400}`,
            borderRadius: 12,
            boxSizing: 'border-box',
            margin: 16,
            maxWidth: 420,
            padding: '32px 28px',
            width: '100%',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              alignItems: 'center',
              border: `1px solid ${DANGER_400}55`,
              borderRadius: 8,
              color: DANGER_400,
              display: 'flex',
              fontSize: 24,
              fontWeight: 700,
              height: 48,
              justifyContent: 'center',
              margin: '0 auto 20px',
              width: 48,
            }}
          >
            !
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ color: PAPER_400, fontSize: 14, lineHeight: 1.6, margin: '8px 0 24px' }}>
            auto·swe could not load. Reloading usually fixes it.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
            <button
              onClick={() => reset()}
              style={{ ...button, background: ACCENT_500, color: '#ffffff' }}
              type="button"
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                ...button,
                background: 'transparent',
                borderColor: INK_400,
                color: PAPER_400,
              }}
            >
              Go home
            </a>
          </div>
          {support && (
            <address
              aria-label="Support"
              style={{ color: PAPER_400, fontSize: 12, fontStyle: 'normal', marginTop: 24 }}
            >
              <div>Support</div>
              {support.url && (
                <div>
                  <a
                    href={support.url}
                    rel="noopener noreferrer"
                    style={supportLink}
                    target="_blank"
                  >
                    {support.url}
                    <span style={visuallyHidden}> (opens in a new tab)</span>
                  </a>
                </div>
              )}
              {support.email && (
                <div>
                  <a
                    href={`mailto:${support.email.split('@').map(encodeURIComponent).join('@')}`}
                    style={supportLink}
                  >
                    {support.email}
                  </a>
                </div>
              )}
              {support.slack && (
                <div>
                  {support.slack.href ? (
                    <a
                      href={support.slack.href}
                      rel="noopener noreferrer"
                      style={supportLink}
                      target="_blank"
                    >
                      {support.slack.text}
                      <span style={visuallyHidden}> (opens in a new tab)</span>
                    </a>
                  ) : (
                    support.slack.text
                  )}
                </div>
              )}
            </address>
          )}
        </main>
      </body>
    </html>
  );
}
