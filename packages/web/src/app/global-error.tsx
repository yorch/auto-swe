'use client';

// Replaces the root layout when it itself throws, so it renders its own <html>
// and cannot rely on the app's providers or stylesheet: styles are inline, and
// every colour is a design token's value from globals.css, named after it.
const INK_800 = '#0c0f17';
const INK_900 = '#0e111a';
const INK_400 = '#232b40';
const PAPER_50 = '#eef1f7';
const PAPER_400 = '#aeb6c9';
const EMBER_500 = '#6a5bff';
const BRICK_400 = '#ff7a7a';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  const button = {
    alignItems: 'center',
    border: '1px solid transparent',
    borderRadius: 10,
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
            borderRadius: 16,
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
              border: `1px solid ${BRICK_400}55`,
              borderRadius: 14,
              color: BRICK_400,
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
              style={{ ...button, background: EMBER_500, color: '#ffffff' }}
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
        </main>
      </body>
    </html>
  );
}
