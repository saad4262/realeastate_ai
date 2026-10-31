import { SkeletonBar } from '@/components/page-skeleton';

/** Removed members' shape while the list loads: the heading, a line, a few rows with Undo. */
export default function Loading() {
  return (
    <div style={{ padding: '1.5rem', maxWidth: '48rem' }} aria-busy="true">
      <span className="sr-only">Loading</span>
      <SkeletonBar height="1.65rem" width="14rem" />
      <div style={{ margin: '1rem 0' }}>
        <SkeletonBar height="0.875rem" width="60%" />
      </div>
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <SkeletonBar height="1rem" width="60%" />
            <SkeletonBar height="1.9rem" width="5rem" radius="0.375rem" />
          </div>
        ))}
      </div>
    </div>
  );
}
