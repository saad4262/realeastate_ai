import type { ReactNode } from 'react';

export type Surface = 'web' | 'agent' | 'agency';

const titles: Record<Surface, string> = {
  web: 'Property Platform',
  agent: 'Agent console',
  agency: 'Agency console',
};

const accents: Record<Surface, string> = {
  web: '#0b3d2e',
  agent: '#1e3a5f',
  agency: '#4a2c0b',
};

type AppShellProps = {
  surface: Surface;
  children: ReactNode;
};

/**
 * Shared shell for all three surfaces. Branding follows `surface`
 * (resolved from host in console middleware — never hardcode in pages).
 */
export function AppShell({ surface, children }: AppShellProps) {
  const accent = accents[surface];

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg)',
        color: 'var(--color-fg)',
      }}
    >
      <header
        style={{
          borderBottom: '1px solid var(--color-border)',
          padding: '1rem 1.5rem',
          display: 'flex',
          alignItems: 'baseline',
          gap: '1rem',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.35rem',
            fontWeight: 600,
            color: accent,
          }}
        >
          {titles[surface]}
        </span>
        <span style={{ color: 'var(--color-muted)', fontSize: '0.85rem' }}>
          surface: {surface}
        </span>
      </header>
      <main style={{ flex: 1, padding: '2rem 1.5rem', maxWidth: 960, width: '100%', margin: '0 auto' }}>
        {children}
      </main>
    </div>
  );
}
