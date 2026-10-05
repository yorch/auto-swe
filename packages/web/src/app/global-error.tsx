'use client';

// Replaces the root layout when it itself throws, so it renders its own <html>
// and cannot rely on the app's providers or stylesheet: styles are inline.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  const button = {
    background: '#7c6cff',
    border: 'none',
    borderRadius: 10,
    color: '#0a0c12',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: 600,
    padding: '8px 16px',
  } as const;
  return (
    <html lang="en">
      <body
        style={{
          alignItems: 'center',
          background: '#0c0f17',
          color: '#eef1f7',
          display: 'flex',
          fontFamily: 'system-ui, sans-serif',
          justifyContent: 'center',
          margin: 0,
          minHeight: '100vh',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 420, padding: 24 }}>
          <h1 style={{ fontSize: 20 }}>Something went wrong</h1>
          <p style={{ color: '#aeb6c9', fontSize: 14 }}>
            auto·swe could not load. Reloading usually fixes it.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button onClick={() => reset()} style={button} type="button">
              Try again
            </button>
            <a href="/" style={{ ...button, background: 'transparent', color: '#aeb6c9' }}>
              Go home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
