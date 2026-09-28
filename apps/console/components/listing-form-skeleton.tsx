import { SkeletonBar } from './page-skeleton';
import formStyles from './listing-form.module.css';
import photoStyles from './photo-uploader.module.css';

/**
 * The listing form's own shape, while the server fetches the row to fill it.
 *
 * Built out of `listing-form.module.css` rather than out of generic rectangles.
 * The section cards, the field grid and the footer are the real classes, so the
 * skeleton cannot drift away from the form's measurements when the form changes
 * — which is the failure mode ARCHITECTURE.md § 10 warns about ("a skeleton of
 * the wrong height is a layout shift with extra steps").
 *
 * The previous loader here was the console-wide PageSkeleton: a title, three
 * stat tiles and one card. On an edit page that reads as the wrong page having
 * loaded, not as this page loading.
 */
function Fields({ count }: { count: number }) {
  return (
    <div className={formStyles.grid}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={formStyles.field}>
          <SkeletonBar height={12} width={i % 3 === 0 ? 88 : 64} radius="0.25rem" />
          {/* 0.5625rem padding + 1px border, top and bottom, on a 0.8125rem
              line — the same 36px box the real input occupies. */}
          <SkeletonBar height={36} radius="0.5rem" />
        </div>
      ))}
    </div>
  );
}

function Section({ hintLines = 1, children }: { hintLines?: number; children?: React.ReactNode }) {
  return (
    <section className={formStyles.section}>
      <SkeletonBar height={15} width={168} radius="0.25rem" />
      <div style={{ display: 'grid', gap: '0.25rem', margin: '0.5rem 0 1rem' }}>
        {Array.from({ length: hintLines }, (_, i) => (
          <SkeletonBar key={i} height={11} width={i === hintLines - 1 ? '62%' : '100%'} radius="0.25rem" />
        ))}
      </div>
      {children}
    </section>
  );
}

export function ListingFormSkeleton() {
  return (
    <div className={formStyles.form} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the listing</span>

      {/* Listing type — two channel chips. */}
      <Section>
        <div className={formStyles.channels}>
          <SkeletonBar height={35} width={104} radius="0.5rem" />
          <SkeletonBar height={35} width={104} radius="0.5rem" />
        </div>
      </Section>

      {/* The property — the address box, then the twelve-field grid. */}
      <Section hintLines={2}>
        <div className={formStyles.wide} style={{ marginBottom: '0.875rem' }}>
          <SkeletonBar height={12} width={180} radius="0.25rem" />
          <div style={{ height: '0.375rem' }} />
          <SkeletonBar height={36} radius="0.5rem" />
        </div>
        <Fields count={12} />
      </Section>

      {/* Where it is on the map — the map itself is lazy-loaded even when the
          data is in hand, so this block is what the real page shows too. */}
      <Section hintLines={3}>
        <SkeletonBar height={300} radius="0.625rem" />
      </Section>

      {/* The advertisement — headline, price copy, description. */}
      <Section hintLines={2}>
        <Fields count={5} />
        <div style={{ marginTop: '0.875rem', display: 'grid', gap: '0.375rem' }}>
          <SkeletonBar height={12} width={96} radius="0.25rem" />
          <SkeletonBar height={120} radius="0.5rem" />
        </div>
      </Section>

      <div className={formStyles.footer}>
        <SkeletonBar height={38} width={148} radius="0.5rem" />
        <SkeletonBar height={38} width={84} radius="0.5rem" />
      </div>
    </div>
  );
}

/**
 * The photo panel on its own, so the edit page can stream it.
 *
 * The photos are a second round trip after the listing (see the note in the
 * edit pages for why it is second and not parallel). Behind a boundary of its
 * own, the form is usable while it finishes instead of the whole page waiting.
 */
export function ListingPhotosSkeleton() {
  return (
    <div className={photoStyles.wrap} aria-busy="true">
      <div className={photoStyles.head}>
        <div style={{ display: 'grid', gap: '0.25rem' }}>
          <SkeletonBar height={12} width={52} radius="0.25rem" />
          <SkeletonBar height={11} width={280} radius="0.25rem" />
        </div>
        <SkeletonBar height={30} width={104} radius="0.5rem" />
      </div>
      <ul className={photoStyles.grid}>
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className={photoStyles.tile}>
            <SkeletonBar height="100%" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The `<h1>` + address line both edit pages render above the form. */
export function ListingFormHeadingSkeleton({ width = 320 }: { width?: number }) {
  return (
    <div style={{ display: 'grid', gap: '0.375rem' }}>
      <SkeletonBar height={24} width={168} radius="0.375rem" />
      <SkeletonBar height={13} width={width} radius="0.25rem" />
    </div>
  );
}
