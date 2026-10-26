import Link from 'next/link';
import { listOpportunities } from '@repo/core/opportunities';
import type { Actor } from '@repo/core/permissions';
import { getConsoleDb } from '@/lib/db';
import { OpportunityButtons } from './opportunity-buttons';
import styles from './opportunities.module.css';

/**
 * "Opportunities" on the assistant home (ADR 0054): what the hourly scan noticed for THIS person,
 * newest first. One statement; streams behind the caller's Suspense, so the page never waits on it.
 * Nothing open → nothing drawn. Every sentence is a template over SQL facts; the buttons only open a
 * page, type a question into the assistant's box (the person sends it), or record Done / Dismiss.
 */
export async function OpportunitiesPanel({ actor, surface }: { actor: Actor; surface: 'agency' | 'agent' }) {
  const list = await listOpportunities(getConsoleDb(), actor, { limit: 8 }).catch(() => null);
  if (!list || !list.rows.length) return null;
  const home = surface === 'agency' ? '/overview' : '/assistant';
  const contacts = surface === 'agency' ? '/customers' : '/my-contacts';
  const inbox = surface === 'agency' ? '/inbox' : '/my-inbox';
  // A matched listing is live, so its public page opens for anyone — unlike the console's listing editor.
  const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://web.lvh.me:3000';

  return (
    <section id="opportunities" className={styles.card} aria-labelledby="opportunities-title">
      <div className={styles.head}>
        <h2 id="opportunities-title" className={styles.title}>
          Opportunities
        </h2>
        <span className={styles.count}>
          {list.total > list.rows.length ? `${list.rows.length} of ${list.total} open` : `${list.total} open`}
        </span>
      </div>
      <p className={styles.hint}>Noticed by the assistant from your contacts, emails and sales. Nothing is sent for you.</p>
      <ul className={styles.list}>
        {list.rows.map((o) => {
          const open = o.threadId
            ? o.contactId
              ? `${contacts}/${o.contactId}?tab=emails&thread=${o.threadId}`
              : `${inbox}?thread=${o.threadId}`
            : o.contactId
              ? `${contacts}/${o.contactId}${o.kind === 'buyer_match' ? '?tab=requirements' : ''}`
              : null;
          const ask = `${home}?${new URLSearchParams({ ...(o.contactId ? { contact: o.contactId } : {}), ask: o.ask }).toString()}`;
          return (
            <li key={o.id} className={styles.row}>
              <span className={styles.label}>{o.label}</span>
              <div className={styles.what}>
                <span className={styles.name}>{o.title}</span>
                {o.detail ? <span className={styles.detail}>{o.detail}</span> : null}
                <span className={styles.links}>
                  {open ? (
                    <Link href={open} className={styles.link}>
                      Open
                    </Link>
                  ) : null}
                  {o.kind === 'buyer_match' && o.listingId ? (
                    <a href={`${webUrl}/listing/${o.listingId}`} target="_blank" rel="noopener" className={styles.link}>
                      The listing ↗
                    </a>
                  ) : null}
                  <Link href={ask} className={styles.link}>
                    Ask the assistant
                  </Link>
                </span>
              </div>
              <OpportunityButtons id={o.id} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
