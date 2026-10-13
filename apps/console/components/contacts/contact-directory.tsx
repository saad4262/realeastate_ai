import Link from 'next/link';
import { PickContact, PickedBar } from './pick-contact';
import {
  CONTACT_ROLE_LABELS,
  CONTACT_ROLES,
  CONTACT_SOURCE_LABELS,
  CONTACT_SOURCES,
  type ContactAssignee,
  type ContactListQuery,
  type ContactPage,
} from '@repo/core/contacts';
import { SaveFilterForm } from '@/components/bulk-email/islands';
import styles from './contacts.module.css';

const WHEN = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

/** The URL for this directory with these filters — what every link and the pager use. */
function hrefFor(basePath: string, query: Partial<ContactListQuery>, page: number): string {
  const p = new URLSearchParams();
  if (query.q) p.set('q', query.q);
  if (query.role) p.set('role', query.role);
  if (query.source) p.set('source', query.source);
  if (query.assigned) p.set('assigned', query.assigned);
  if (query.archived) p.set('archived', query.archived);
  if (page > 1) p.set('page', String(page));
  const s = p.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/**
 * The contact directory (ADR 0018) — the agency's `/customers` and the agent's
 * `/my-contacts`, one component. A server component with no client code: the
 * filters are a GET form, so they live in the URL, Back works, and a filtered
 * list can be sent to a colleague.
 *
 * What is IN the list was decided by can() and its SQL twin in packages/core;
 * this only draws it. `page.seesAll` (from can()) decides whether the
 * "assigned to" filter may name other members.
 */
export function ContactDirectory({
  page,
  query,
  basePath,
  title,
  subtitle,
  assignees,
}: {
  page: ContactPage;
  query: Partial<ContactListQuery>;
  basePath: string;
  title: string;
  subtitle: string;
  /** Members to filter by. Empty unless this actor may assign (can()). */
  assignees: ContactAssignee[];
}) {
  const filtered = Boolean(query.q || query.role || query.source || query.assigned || query.archived);
  const first = (page.page - 1) * page.pageSize + 1;
  const last = first + page.rows.length - 1;
  const hasNext = last < page.total;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.sub}>{subtitle}</p>
        </div>
        {page.mayCreate ? (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {/* Whoever may add a contact may import them (contact_import:create, the same rule). */}
            <Link href={`${basePath}/import`} className={styles.btn}>
              Import
            </Link>
            <Link href={`${basePath}/new`} className={styles.btn}>
              <span aria-hidden>+</span> New contact
            </Link>
          </div>
        ) : null}
      </div>

      <form className={styles.filters} method="get" action={basePath} role="search">
        <input
          className={styles.input}
          type="search"
          name="q"
          defaultValue={query.q ?? ''}
          placeholder="Search name, email or phone"
          aria-label="Search contacts"
        />
        <select className={styles.select} name="role" defaultValue={query.role ?? ''} aria-label="Role">
          <option value="">Any role</option>
          {CONTACT_ROLES.map((r) => (
            <option key={r} value={r}>{CONTACT_ROLE_LABELS[r]}</option>
          ))}
        </select>
        <select className={styles.select} name="source" defaultValue={query.source ?? ''} aria-label="Source">
          <option value="">Any source</option>
          {CONTACT_SOURCES.map((s) => (
            <option key={s} value={s}>{CONTACT_SOURCE_LABELS[s]}</option>
          ))}
        </select>
        <select className={styles.select} name="assigned" defaultValue={query.assigned ?? ''} aria-label="Assigned to">
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          {page.seesAll ? <option value="none">Unassigned</option> : null}
          {page.seesAll
            ? assignees.map((a) => (
                <option key={a.userId} value={a.userId}>{a.name}</option>
              ))
            : null}
        </select>
        <select className={styles.select} name="archived" defaultValue={query.archived ?? ''} aria-label="Archived">
          <option value="">Current</option>
          <option value="archived">Archived only</option>
          <option value="all">Current and archived</option>
        </select>
        <button type="submit" className={styles.btnGhost}>Filter</button>
        {filtered ? <Link href={basePath} className={styles.back}>Clear</Link> : null}
      </form>
      {filtered && page.mayCreate ? (
        <SaveFilterForm
          query={{
            ...(query.q ? { q: query.q } : {}),
            ...(query.role ? { role: query.role } : {}),
            ...(query.source ? { source: query.source } : {}),
            ...(query.assigned ? { assigned: query.assigned } : {}),
            ...(query.archived ? { archived: query.archived } : {}),
          }}
        />
      ) : null}

      <div className={styles.card}>
        {page.rows.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{filtered ? 'Nobody matches those filters' : 'No contacts yet'}</p>
            <p className={styles.emptyHint}>
              {filtered
                ? 'Try fewer filters, or search by part of a name.'
                : 'Everyone who enquires, makes an offer or emails the agency appears here automatically.'}
            </p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th aria-label="Pick for the assistant" />
                <th>Name</th>
                <th>Contact</th>
                <th>Roles</th>
                <th>Source</th>
                <th>Assigned to</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <PickContact id={c.id} name={c.name} />
                  </td>
                  <td>
                    <Link href={`${basePath}/${c.id}`} className={styles.name}>{c.name}</Link>
                    {c.archived ? <> <span className={styles.chipInferred}>Archived</span></> : null}
                  </td>
                  <td className={styles.reach}>
                    {c.email ? <div><a href={`mailto:${c.email}`}>{c.email}</a></div> : null}
                    {c.phone ? <div><a href={`tel:${c.phone}`}>{c.phone}</a></div> : null}
                    {!c.email && !c.phone ? <span className={styles.muted}>—</span> : null}
                  </td>
                  <td>
                    {c.roles.length ? (
                      <div className={styles.chips}>
                        {c.roles.map((r) => (
                          <span key={r} className={styles.chip}>{CONTACT_ROLE_LABELS[r]}</span>
                        ))}
                      </div>
                    ) : (
                      <span className={styles.muted}>—</span>
                    )}
                  </td>
                  <td className={styles.muted}>{CONTACT_SOURCE_LABELS[c.source]}</td>
                  <td>{c.assigneeName ?? <span className={styles.muted}>Unassigned</span>}</td>
                  <td className={styles.when}>{WHEN.format(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <PickedBar />
      </div>

      {page.total > 0 ? (
        <div className={styles.pager}>
          <span>
            {first}–{last} of {page.total}
          </span>
          <span className={styles.pagerLinks}>
            {page.page > 1 ? (
              <Link href={hrefFor(basePath, query, page.page - 1)} className={styles.btnGhost}>← Previous</Link>
            ) : null}
            {hasNext ? (
              <Link href={hrefFor(basePath, query, page.page + 1)} className={styles.btnGhost}>Next →</Link>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
