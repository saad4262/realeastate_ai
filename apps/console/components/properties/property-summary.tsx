'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { CheckedPoint, RecordTab } from '@repo/core/properties';
import { summarizePropertyAction } from '@/lib/property-actions';
import dealStyles from '@/components/deals/deals.module.css';
import styles from './properties.module.css';

/**
 * A property's summary (ADR 0065, the user's decision 3): written only when the button is pressed, never
 * saved. Every point cites the records it came from and links to their tab. Every check is core's; this draws.
 */
export function PropertySummary({ propertyId, base, on, offMessage }: { propertyId: string; base: string; on: boolean; offMessage: string | null }) {
  const [points, setPoints] = useState<CheckedPoint[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const tabHref = (t: RecordTab) => (t === 'overview' ? base : `${base}?tab=${t}`);

  const run = () =>
    start(async () => {
      setError(null);
      const r = await summarizePropertyAction(propertyId);
      if (r.ok) {
        setPoints(r.points);
        setCount(r.recordCount);
      } else setError(r.error);
    });

  return (
    <section className={`${dealStyles.panel} ${styles.ai}`} aria-labelledby="property-summary">
      <div className={dealStyles.panelHead}>
        <h3 id="property-summary">
          <span className={`${dealStyles.glyph} ${styles.aiGlyph}`} aria-hidden>auto_awesome</span> Summary
        </h3>
        {points ? <span className={dealStyles.muted}>From {count} records you can see</span> : null}
      </div>
      {!on ? (
        <p className={dealStyles.muted} style={{ margin: 0 }}>{offMessage}</p>
      ) : points ? (
        <>
          <ul className={styles.points}>
            {points.map((p, i) => (
              <li key={i}>
                {p.text}
                {p.cites.map((c) => (
                  <Link key={c.ref} href={tabHref(c.tab)} className={styles.cite}>{c.label}</Link>
                ))}
              </li>
            ))}
          </ul>
          <div className={styles.aiFoot}>
            <span className={dealStyles.glyph} aria-hidden>verified</span>
            Figures checked against the records · not saved
            <button type="button" className={dealStyles.btnLink} onClick={run} disabled={pending}>{pending ? 'Writing…' : 'Redo'}</button>
          </div>
        </>
      ) : (
        <>
          <p className={dealStyles.muted} style={{ margin: '0 0 0.625rem' }}>
            The assistant reads everything on this page that you may see and writes a short summary. Every point links to the record it came from; a figure that is not in a record is not written.
          </p>
          <button type="button" className={`${dealStyles.btn} ${styles.aiBtn}`} onClick={run} disabled={pending} aria-busy={pending}>
            <span className={dealStyles.glyph} aria-hidden>auto_awesome</span>
            {pending ? 'Reading the records…' : 'Summarise this property'}
          </button>
        </>
      )}
      {error ? <p role="alert" className={dealStyles.error} style={{ marginTop: '0.5rem' }}>{error}</p> : null}
    </section>
  );
}
