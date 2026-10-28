import Link from 'next/link';
import { listProperties, PROPERTY_FILTER_LABELS, PROPERTY_FILTERS, PropertyError, type PropertyFilter, type PropertyRow } from '@repo/core/properties';
import contactStyles from '@/components/contacts/contacts.module.css';
import dealStyles from '@/components/deals/deals.module.css';
import { getConsoleDb } from '../../lib/db';
import { loadListingActor } from '../../lib/load-actor';
import { requireConsoleAccess } from '../../lib/require-console-access';
import styles from './properties.module.css';

export function propertiesParams(sp: { q?: string | string[]; filter?: string | string[]; page?: string | string[] }): { q: string; filter: PropertyFilter; page: number } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const filter = one(sp.filter);
  const page = Number(one(sp.page));
  return {
    q: one(sp.q).slice(0, 120),
    filter: (PROPERTY_FILTERS as readonly string[]).includes(filter) ? (filter as PropertyFilter) : 'all',
    page: Number.isInteger(page) && page > 0 ? page : 0,
  };
}

const TONE: Record<PropertyRow['now']['tone'], string> = { deal: dealStyles.pillAuto ?? '', listing: '', settled: dealStyles.pillOk ?? '', none: '' };

/**
 * The Properties list (ADR 0065, the user's decision 2): every address this person may open — owners and
 * admins the agency's, anyone else their own — searchable, filtered, newest activity first. One statement.
 */
export async function PropertiesList({ surface, q, filter, page }: { surface: 'agency' | 'agent'; q: string; filter: PropertyFilter; page: number }) {
  const session = await requireConsoleAccess(surface);
  const actor = (await loadListingActor(session.actor.userId)) ?? session.actor;
  const base = surface === 'agency' ? '/properties' : '/my-properties';
  let r;
  try {
    r = await listProperties(getConsoleDb(), actor, { q, filter, page });
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof PropertyError ? err.message : 'Could not load properties'}</p>;
  }
  const href = (o: { filter?: PropertyFilter; page?: number }) => {
    const s = new URLSearchParams();
    if (q) s.set('q', q);
    const fl = o.filter ?? filter;
    if (fl !== 'all') s.set('filter', fl);
    if (o.page) s.set('page', String(o.page));
    const qs = s.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const day = (d: Date | null) => (d ? d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>Properties</h1>
          <p className={contactStyles.sub}>
            {r.scope === 'agency'
              ? 'Every address the agency has a record of — a listing, an enquiry, an appraisal, an owner or a deal.'
              : 'Your properties: the ones on your listings, your deals, your appointments and your contacts.'}
          </p>
        </div>
        <form className={contactStyles.filters} method="get" action={base} role="search">
          {filter !== 'all' ? <input type="hidden" name="filter" value={filter} /> : null}
          <input type="search" name="q" defaultValue={q} placeholder="Search an address, suburb or postcode" aria-label="Search properties" className={contactStyles.input} />
          <button type="submit" className={contactStyles.btnGhost}>Search</button>
        </form>
      </div>

      <nav className={dealStyles.filters} aria-label="Filter">
        {PROPERTY_FILTERS.map((x) => (
          <Link key={x} href={href({ filter: x, page: 0 })} className={`${dealStyles.chip} ${x === filter ? dealStyles.chipOn : ''}`} aria-current={x === filter ? 'page' : undefined}>
            {PROPERTY_FILTER_LABELS[x]}
          </Link>
        ))}
      </nav>

      <section className={dealStyles.panel} style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className={dealStyles.finTable}>
            <thead>
              <tr><th>Address</th><th>Type</th><th>Now</th><th>Owner</th><th className={dealStyles.num}>Enquiries</th><th>Last activity</th></tr>
            </thead>
            <tbody>
              {r.rows.length === 0 ? (
                <tr><td colSpan={6} className={dealStyles.muted}>{q || filter !== 'all' ? 'No property matches. Try fewer words or another filter.' : 'No properties yet. Addresses appear here with a listing, an enquiry, an appraisal or a linked owner.'}</td></tr>
              ) : null}
              {r.rows.map((p) => (
                <tr key={p.id}>
                  <td><Link href={`${base}/${p.id}`}>{p.address}</Link></td>
                  <td>{[p.propertyType ? p.propertyType[0]!.toUpperCase() + p.propertyType.slice(1) : null, p.bedrooms !== null ? `${p.bedrooms} bed` : null].filter(Boolean).join(' · ') || '—'}</td>
                  <td><span className={`${dealStyles.pill} ${TONE[p.now.tone]}`}>{p.now.label}</span></td>
                  <td>{p.ownerName ?? '—'}</td>
                  <td className={dealStyles.num}>{p.enquiries}</td>
                  <td>{day(p.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {page > 0 || r.hasMore ? (
        <div className={styles.toolbar}>
          {page > 0 ? <Link href={href({ page: page - 1 })} className={contactStyles.btnGhost}>← Newer</Link> : <span />}
          {r.hasMore ? <Link href={href({ page: page + 1 })} className={contactStyles.btnGhost}>Older →</Link> : null}
        </div>
      ) : null}
    </div>
  );
}
