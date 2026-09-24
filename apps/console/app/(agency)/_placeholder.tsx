import Link from 'next/link';

type PlaceholderProps = {
  title: string;
  blurb: string;
};

export function AgencyPlaceholder({ title, blurb }: PlaceholderProps) {
  return (
    <div style={{ maxWidth: 560 }}>
      <h1
        style={{
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontSize: '1.5rem',
          fontWeight: 700,
          letterSpacing: '-0.02em',
        }}
      >
        {title}
      </h1>
      <p style={{ margin: '0.5rem 0 1.25rem', color: 'var(--text-secondary)', fontSize: 14 }}>
        {blurb}
      </p>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
        Stitch screen pending — nav is wired. Continue from{' '}
        <Link href="/overview" style={{ color: 'var(--sapphire)' }}>
          Overview
        </Link>{' '}
        or{' '}
        <Link href="/team" style={{ color: 'var(--sapphire)' }}>
          Agents &amp; Team
        </Link>
        .
      </p>
    </div>
  );
}
