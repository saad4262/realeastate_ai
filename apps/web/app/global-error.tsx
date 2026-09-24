'use client';

/**
 * The last boundary: a failure in the root layout itself.
 *
 * This one replaces the root layout rather than rendering inside it, so it has
 * to supply its own <html> and <body> — and it gets none of the stylesheets
 * the root layout imports. That is why everything here is inline and why it
 * names no font: at the point this renders, there is no guarantee anything
 * else loaded.
 *
 * It should be unreachable. error.tsx catches anything thrown by a page, so
 * arriving here means the layout, the font link or the shell broke.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en-AU">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '1.5rem',
          background: '#f7f4ef',
          color: '#1a1a1a',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        }}
      >
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.75rem', margin: '0 0 0.75rem', letterSpacing: '-0.02em' }}>
            Something went wrong
          </h1>
          <p style={{ color: '#5c5c5c', margin: '0 0 1.75rem', fontSize: '1.0625rem' }}>
            The site could not be loaded. Please try again.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '0.625rem 1.125rem',
              borderRadius: 6,
              border: '1px solid #0b3d2e',
              background: '#0b3d2e',
              color: '#f7f4ef',
              fontSize: '0.9375rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p style={{ marginTop: '1.75rem', fontSize: '0.75rem', color: '#5c5c5c' }}>
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
