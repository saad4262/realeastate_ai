'use client';

/**
 * A failure in the console's root layout.
 *
 * Replaces that layout rather than rendering inside it, so it brings its own
 * <html> and <body> and gets none of the stylesheets the root imports — hence
 * the inline styles and no font family. ToastProvider is gone at this point
 * too, so nothing here may use useToast.
 */
export default function ConsoleGlobalError({
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
          background: '#f8fafc',
          color: '#0f172a',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        }}
      >
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.375rem', margin: '0 0 0.5rem', letterSpacing: '-0.02em' }}>
            The console didn’t load
          </h1>
          <p style={{ color: '#475569', margin: '0 0 1.5rem', fontSize: '0.875rem', lineHeight: 1.6 }}>
            Something failed before the page could be built. Nothing you were working on
            has been changed.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: 8,
              border: '1px solid #2563eb',
              background: '#2563eb',
              color: '#fff',
              fontSize: '0.8125rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p style={{ marginTop: '1.5rem', fontSize: '0.6875rem', color: '#94a3b8' }}>
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
