import { SkeletonBar } from '@/components/page-skeleton';

const box: React.CSSProperties = { border: '1px solid var(--border-default)', borderRadius: '0.5rem', background: 'var(--surface-card)', padding: '1rem', marginTop: '1rem' };

/** Remove a member's shape while the preview counts what they hold: the heading, two boxes. */
export default function Loading() {
  return (
    <div style={{ padding: '1.5rem', maxWidth: '48rem' }} aria-busy="true">
      <span className="sr-only">Loading</span>
      <SkeletonBar height="1.65rem" width="60%" />
      <div style={{ display: 'grid', gap: '0.4rem', margin: '1rem 0' }}>
        <SkeletonBar height="0.875rem" width="95%" />
        <SkeletonBar height="0.875rem" width="70%" />
      </div>
      <section style={box}>
        <SkeletonBar height="1rem" width="9rem" />
        <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.75rem' }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <SkeletonBar key={i} height="0.875rem" />
          ))}
        </div>
      </section>
      <section style={box}>
        <SkeletonBar height="1rem" width="12rem" />
        <div style={{ marginTop: '0.75rem' }}>
          <SkeletonBar height="2rem" />
        </div>
      </section>
    </div>
  );
}
