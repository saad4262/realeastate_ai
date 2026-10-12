import Link from 'next/link';
import { can } from '@repo/core/permissions';
import { ContactError, listContacts, type ContactRow } from '@repo/core/contacts';
import { MailError, previewContactEmail, type ComposePreview } from '@repo/core/mail';
import { getConsoleDb } from '../../lib/db';
import { loadListingActor } from '../../lib/load-actor';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { ComposeForm } from './compose-form';
import styles from './inbox.module.css';

/**
 * "New email" (ADR 0035 §1), shared by `/inbox/new` and `/my-inbox/new`.
 *
 * Without `?contact=`: pick the person — a search over the contacts this
 * actor may email (everyone's for an owner/admin, their own for an agent;
 * `contact:read_all` decides, never a role). With it: the preview from core —
 * who, from which address, today's limits — and the form, or the reason it
 * cannot be sent.
 */
export async function ComposePage({
  surface,
  searchParams,
}: {
  surface: 'agency' | 'agent';
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess(surface);
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || '';
  const contactId = first(params.contact);
  const q = first(params.q).slice(0, 120);
  const inboxPath = surface === 'agency' ? '/inbox' : '/my-inbox';
  const newPath = `${inboxPath}/new`;
  const db = getConsoleDb();
  const actor = (await loadListingActor(session.actor.userId)) ?? session.actor;

  const head = (
    <div className={styles.head}>
      <div>
        <h1 className={styles.title}>New email</h1>
        <p className={styles.sub}>Write to one of your contacts. Their reply comes back to the inbox, and they can read it on the website too.</p>
      </div>
    </div>
  );

  if (contactId) {
    let preview: ComposePreview | null = null;
    let refusal: string | null = null;
    try {
      preview = await previewContactEmail(db, actor, contactId);
    } catch (err) {
      refusal = err instanceof MailError ? err.message : 'Could not open that contact';
    }
    return (
      <div className={styles.wrap}>
        {head}
        <section className={styles.card} aria-label="New email">
          <div className={styles.toolbar}>
            <Link href={newPath} className={styles.back}>
              ← Choose someone else
            </Link>
          </div>
          {refusal || !preview ? (
            <p className={styles.alert} role="alert">
              {refusal}
            </p>
          ) : (
            <div className={styles.composeCard}>
              <dl className={styles.composeMeta}>
                <dt>To</dt>
                <dd>
                  {preview.contact.name}
                  {preview.contact.email ? ` · ${preview.contact.email}` : ''}
                </dd>
                <dt>From</dt>
                <dd>{preview.sendFrom}</dd>
                <dt>Today</dt>
                <dd>
                  {preview.limits.agentUsed} of {preview.limits.limits.perAgentDay} emails you may send today
                </dd>
              </dl>
              {preview.problem ? (
                <p className={styles.banner} role="note">
                  {preview.problem}
                </p>
              ) : (
                <ComposeForm contactId={preview.contact.id} to={preview.contact.name} inboxPath={inboxPath} />
              )}
            </div>
          )}
        </section>
      </div>
    );
  }

  // Pick a person. An agent sees the contacts they hold — the only ones they may write to.
  const directory = { type: 'contact', agencyId: actor.agencyId ?? undefined };
  const seesAll = can(actor, 'contact:read_all', directory);
  let rows: ContactRow[] = [];
  let error: string | null = null;
  try {
    const page = await listContacts(db, actor, { ...(q ? { q } : {}), ...(seesAll ? {} : { assigned: 'me' as const }) });
    rows = page.rows;
  } catch (err) {
    error = err instanceof ContactError ? err.message : 'Could not load your contacts';
  }

  return (
    <div className={styles.wrap}>
      {head}
      <section className={styles.card} aria-label="Choose a contact">
        <div className={styles.toolbar}>
          <Link href={inboxPath} className={styles.back}>
            ← Inbox
          </Link>
        </div>
        <form className={styles.searchRow} action={newPath} method="get" role="search">
          <input
            className={styles.input}
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search by name, email or phone"
            aria-label="Search contacts"
          />
          <button type="submit" className={styles.send}>
            Search
          </button>
        </form>
        {error ? (
          <p className={styles.alert} role="alert">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{q ? 'Nobody matches that' : 'No contacts yet'}</p>
            <p className={styles.emptyHint}>{seesAll ? 'Search the whole agency’s contacts.' : 'You can email the contacts assigned to you.'}</p>
          </div>
        ) : (
          <ul className={styles.pickList}>
            {rows.map((r) => (
              <li key={r.id} className={styles.pickItem}>
                {r.email && !r.archived ? (
                  <Link href={`${newPath}?contact=${r.id}`} className={styles.pick}>
                    <span>
                      {r.name}
                      <span className={styles.pickSub}>{r.email}</span>
                    </span>
                    <span className={styles.pickAction}>Write</span>
                  </Link>
                ) : (
                  <div className={styles.pick}>
                    <span>
                      {r.name}
                      <span className={styles.pickSub}>{r.archived ? 'Archived' : 'No email address'}</span>
                    </span>
                    <span className={`${styles.pickAction} ${styles.pickDisabled}`}>—</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
