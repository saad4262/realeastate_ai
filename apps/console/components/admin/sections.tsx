import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { listAppointments } from '@repo/core/appointments';
import { getContact, listContactNotes, listContactTimeline, listContacts, type TimelineItem } from '@repo/core/contacts';
import { listAgencyLeads, type LeadKind } from '@repo/core/leads';
import { CONSOLE_PAGE_SIZE, listAgencyListingsPage } from '@repo/core/listings';
import { getMailThread, listMailThreads, parseMailFolder, type MailFolder } from '@repo/core/mail';
import {
  getPlatformAssistantChat,
  getPlatformTeamThread,
  listPlatformAssistantChats,
  listPlatformTeamThreads,
  type PlatformView,
} from '@repo/core/platform';
import { listWorkflows } from '@repo/core/workflows';
import { Agenda } from '@/components/appointments/agenda';
import { toItem } from '@/components/appointments/item';
import { RichText } from '@/components/assistant/rich-text';
import { ThreadList, ThreadReader } from '@/components/inbox/inbox-view';
import { LeadTable } from '@/components/lead-table';
import { getConsoleDb } from '../../lib/db';
import { recordPlatformView } from '../../lib/require-platform-admin';
import styles from './admin.module.css';

/**
 * The areas of an agency, or of one member of it, as the admin console shows
 * them (ADR 0049). Each section takes a VIEW — the read-only actor
 * platformViewActor built — and hands it to the same core reads the agency's
 * own console uses, so what an admin sees is what that owner or member sees.
 * Nothing here writes, and every section records itself in the view log
 * BEFORE it reads (recordPlatformView fails closed).
 *
 * `base` is where the section lives: /agencies/[id] for the agency,
 * /agencies/[id]/agents/[userId] for a member.
 */

type Params = Record<string, string | string[] | undefined>;
type Section = { view: PlatformView; base: string; params: Params };

export function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const WEB_URL = () => process.env.NEXT_PUBLIC_WEB_URL ?? 'http://web.lvh.me:3000';

function Failed({ err, what }: { err: unknown; what: string }) {
  return (
    <p role="alert" className={styles.alert}>
      {err instanceof Error && err.message ? err.message : `Could not load ${what}`}
    </p>
  );
}

function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className={styles.headText}>
      <h2 className={styles.h2}>{title}</h2>
      {sub ? <p className={styles.sub}>{sub}</p> : null}
    </div>
  );
}

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

// ── Leads ─────────────────────────────────────────────────────────────────

const KINDS: readonly LeadKind[] = ['enquiry', 'inspection', 'appraisal', 'offer'];

export async function LeadsSection({ view, base, params }: Section) {
  await recordPlatformView(view.actor, 'leads');
  const raw = first(params.kind);
  const kind = KINDS.includes(raw as LeadKind) ? (raw as LeadKind) : undefined;
  try {
    const page = await listAgencyLeads(getConsoleDb(), view.actor, { ...(kind ? { kind } : {}), limit: 100 });
    return (
      <LeadTable
        title="Leads"
        subtitle={view.subject ? `What ${view.subject.name} sees in their lead inbox.` : 'Every lead in the agency.'}
        webUrl={WEB_URL()}
        rows={page.rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
        counts={page.counts}
        {...(kind ? { kind } : {})}
        maySeeOffers={page.maySeeOffers}
        assignees={[]}
        basePath={`${base}/leads`}
        inboxPath={`${base}/inbox`}
      />
    );
  } catch (err) {
    return <Failed err={err} what="leads" />;
  }
}

// ── Customers ─────────────────────────────────────────────────────────────

export async function CustomersSection({ view, base, params }: Section) {
  await recordPlatformView(view.actor, 'customers');
  const q = first(params.q)?.trim() ?? '';
  const pageNo = Math.max(1, Number(first(params.page)) || 1);
  try {
    const page = await listContacts(getConsoleDb(), view.actor, { ...(q ? { q } : {}), archived: 'all', page: pageNo });
    const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
    const href = (p: number) => `${base}/customers?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;
    return (
      <div className={styles.wrap}>
        <div className={styles.head}>
          <SectionHead title="Customers" sub={`${page.total} ${page.total === 1 ? 'contact' : 'contacts'}, archived included.`} />
          <form method="get" action={`${base}/customers`} className={styles.filters}>
            <input className={styles.input} type="search" name="q" defaultValue={q} placeholder="Name, email or phone" aria-label="Search customers" />
            <button type="submit" className={styles.btn}>Search</button>
          </form>
        </div>
        <section className={styles.card}>
          {page.rows.length === 0 ? (
            <p className={styles.empty}>No customers{q ? ' match that search' : ''}.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr><th>Name</th><th>Email / phone</th><th>Roles</th><th>Assigned to</th><th>Added</th></tr>
              </thead>
              <tbody>
                {page.rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link className={styles.name} href={`${base}/customers/${c.id}`}>{c.name}</Link>
                      {c.archived ? <> <span className={styles.badge}>Archived</span></> : null}
                    </td>
                    <td data-label="Reach" className={styles.muted}>{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</td>
                    <td data-label="Roles">{c.roles.join(', ') || '—'}</td>
                    <td data-label="Assigned to">{c.assigneeName ?? <span className={styles.muted}>Nobody</span>}</td>
                    <td data-label="Added"><LocalTime iso={iso(c.createdAt)} style="date" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {pages > 1 ? (
          <div className={styles.filters}>
            {pageNo > 1 ? <Link className={styles.btn} href={href(pageNo - 1)}>← Newer</Link> : null}
            <span className={styles.muted}>Page {pageNo} of {pages}</span>
            {pageNo < pages ? <Link className={styles.btn} href={href(pageNo + 1)}>Older →</Link> : null}
          </div>
        ) : null}
      </div>
    );
  } catch (err) {
    return <Failed err={err} what="customers" />;
  }
}

function timelineLine(item: TimelineItem): { label: string; text: string } {
  switch (item.type) {
    case 'lead':
      return { label: `${item.kind} · ${item.address}`, text: item.message ?? '' };
    case 'email':
      return { label: `${item.direction === 'in' ? 'Email in' : 'Email out'}${item.failed ? ' (not delivered)' : ''} · ${item.subject}`, text: item.preview };
    case 'note':
      return { label: item.isPrivate ? 'Private note' : 'Note', text: item.body };
    case 'activity':
      return { label: item.kind.replace(/_/g, ' '), text: '' };
  }
}

export async function CustomerDetail({ view, base, contactId }: { view: PlatformView; base: string; contactId: string }) {
  await recordPlatformView(view.actor, 'customer', contactId);
  const db = getConsoleDb();
  let contact;
  try {
    contact = await getContact(db, view.actor, contactId);
  } catch (err) {
    return <Failed err={err} what="that customer" />;
  }
  if ('mergedInto' in contact) {
    return (
      <p className={styles.sub}>
        This contact was merged. <Link href={`${base}/customers/${contact.mergedInto}`}>Open the one it was merged into →</Link>
      </p>
    );
  }
  const [notes, timeline, meetings, threads] = await Promise.all([
    listContactNotes(db, view.actor, contact.ref).catch(() => []),
    listContactTimeline(db, view.actor, contact.ref, { limit: 50 }).catch(() => ({ items: [], nextBefore: null })),
    listAppointments(db, view.actor, { contact: contact.ref, when: 'upcoming', limit: 20 }).catch(() => null),
    listMailThreads(db, view.actor, { folder: 'all', contactId: contact.id, limit: 20 }).catch(() => null),
  ]);

  return (
    <div className={styles.wrap}>
      <div className={styles.crumbs}><Link href={`${base}/customers`}>← Customers</Link></div>
      <SectionHead title={contact.name} sub={[contact.email, contact.phone].filter(Boolean).join(' · ')} />
      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <dl className={styles.facts}>
              <dt>Roles</dt><dd>{contact.roles.join(', ') || '—'}</dd>
              <dt>Source</dt><dd>{contact.source}</dd>
              <dt>Assigned to</dt><dd>{contact.assigneeName ?? 'Nobody'}</dd>
              <dt>Next action</dt><dd>{contact.nextAction ?? '—'}{contact.nextActionAt ? <> · <LocalTime iso={iso(contact.nextActionAt)} /></> : null}</dd>
              <dt>Marketing</dt><dd>{contact.marketingConsent ? 'Consented' : 'No consent recorded'}{contact.emailOptOutAt ? ' · opted out of email' : ''}</dd>
              <dt>Added</dt><dd><LocalTime iso={iso(contact.createdAt)} style="date" /></dd>
              {contact.archivedAt ? (<><dt>Archived</dt><dd><LocalTime iso={iso(contact.archivedAt)} style="date" /></dd></>) : null}
            </dl>
          </div>
        </section>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h3 className={styles.h2}>Notes ({notes.length})</h3>
            {notes.length === 0 ? <p className={styles.muted}>No notes.</p> : notes.map((n) => (
              <div key={n.id} className={styles.message}>
                <div className={styles.messageMeta}>
                  <span className={styles.messageWho}>{n.authorName ?? 'Former member'}</span>
                  <LocalTime iso={iso(n.createdAt)} />
                  {n.isPrivate ? <span className={styles.badgeWarn}>Private</span> : null}
                </div>
                <div className={styles.messageText}>{n.body}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className={styles.card}>
        <div className={styles.cardBody}><h3 className={styles.h2}>Email conversations</h3></div>
        {threads && threads.rows.length ? (
          <ThreadList rows={threads.rows} threadHref={(id) => `${base}/inbox?thread=${id}`} emptyTitle="" emptyHint="" />
        ) : (
          <p className={styles.empty}>No email conversations.</p>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardBody}><h3 className={styles.h2}>Upcoming meetings</h3></div>
        <div className={styles.cardBody}>
          <Agenda items={(meetings?.rows ?? []).map(toItem)} showContact={false} contactBasePath={`${base}/customers`} emptyText="Nothing booked." />
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardBody}><h3 className={styles.h2}>Timeline</h3></div>
        {timeline.items.length === 0 ? (
          <p className={styles.empty}>Nothing yet.</p>
        ) : (
          <div className={styles.messages}>
            {timeline.items.map((item) => {
              const line = timelineLine(item);
              return (
                <div key={`${item.type}-${item.id}`} className={styles.message}>
                  <div className={styles.messageMeta}>
                    <span className={styles.messageWho}>{line.label}</span>
                    {item.who ? <span>{item.who}</span> : null}
                    <LocalTime iso={iso(item.at)} />
                  </div>
                  {line.text ? <div className={styles.messageText}>{line.text}</div> : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Inbox ─────────────────────────────────────────────────────────────────

const FOLDERS: { key: MailFolder; label: string }[] = [
  { key: 'all', label: 'Inbox' },
  { key: 'unread', label: 'Unread' },
  { key: 'mine', label: 'Assigned' },
  { key: 'offers', label: 'Offers' },
  { key: 'general', label: 'Agency mailbox' },
];

export async function InboxSection({ view, base, params }: Section) {
  const threadId = first(params.thread)?.trim() || null;
  await recordPlatformView(view.actor, threadId ? 'email_thread' : 'inbox', threadId);
  const folder = parseMailFolder(params.folder);
  const db = getConsoleDb();
  const href = (f: MailFolder, t?: string) => {
    const p = new URLSearchParams();
    if (f !== 'all') p.set('folder', f);
    if (t) p.set('thread', t);
    const s = p.toString();
    return s ? `${base}/inbox?${s}` : `${base}/inbox`;
  };

  if (threadId) {
    try {
      const thread = await getMailThread(db, view.actor, threadId);
      return (
        <section className={styles.card}>
          <ThreadReader
            view={thread}
            unread={false}
            backHref={href(folder)}
            assignees={[]}
            inboundOn
            webUrl={WEB_URL()}
            readOnly
          />
        </section>
      );
    } catch (err) {
      return <Failed err={err} what="that conversation" />;
    }
  }

  try {
    const page = await listMailThreads(db, view.actor, { folder, limit: 100 });
    const shown = FOLDERS.filter((f) => (f.key === 'offers' ? page.folders.offers : f.key === 'general' ? page.folders.general : true));
    return (
      <div className={styles.wrap}>
        <SectionHead
          title="Inbox"
          sub={view.subject ? `${view.subject.name}'s inbox. "Unread" is their unread state; opening a conversation here does not change it.` : "The agency's whole inbox. Opening a conversation here marks nothing read."}
        />
        <nav className={styles.tabs} aria-label="Folders">
          {shown.map((f) => (
            <Link key={f.key} href={href(f.key)} className={folder === f.key ? styles.tabOn : styles.tab}>
              {f.label}
            </Link>
          ))}
        </nav>
        <section className={styles.card}>
          <ThreadList rows={page.rows} threadHref={(id) => href(folder, id)} emptyTitle="No conversations here" emptyHint="" />
        </section>
      </div>
    );
  } catch (err) {
    return <Failed err={err} what="the inbox" />;
  }
}

// ── Meetings ──────────────────────────────────────────────────────────────

export async function MeetingsSection({ view, base, params }: Section) {
  await recordPlatformView(view.actor, 'meetings');
  const when = first(params.when) === 'past' ? 'past' : 'upcoming';
  try {
    const page = await listAppointments(getConsoleDb(), view.actor, { when, limit: 200 });
    return (
      <div className={styles.wrap}>
        <SectionHead
          title="Meetings"
          sub={view.subject ? `${view.subject.name}'s appointments and the team meetings they are on.` : 'Every appointment and team meeting in the agency.'}
        />
        <nav className={styles.tabs} aria-label="Which meetings">
          <Link href={`${base}/meetings`} className={when === 'upcoming' ? styles.tabOn : styles.tab}>Upcoming</Link>
          <Link href={`${base}/meetings?when=past`} className={when === 'past' ? styles.tabOn : styles.tab}>Past</Link>
        </nav>
        <Agenda
          items={page.rows.map(toItem)}
          showContact
          contactBasePath={`${base}/customers`}
          emptyText={when === 'upcoming' ? 'Nothing booked.' : 'No past meetings.'}
        />
      </div>
    );
  } catch (err) {
    return <Failed err={err} what="meetings" />;
  }
}

// ── Listings ──────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, string> = {
  live: styles.badgeGood!,
  under_offer: styles.badgeWarn!,
  pending: styles.badgeWarn!,
  sold: styles.badge!,
  draft: styles.badge!,
  withdrawn: styles.badgeBad!,
};

export async function ListingsSection({ view, base, params }: Section) {
  await recordPlatformView(view.actor, 'listings');
  const pageNo = Math.max(1, Number(first(params.page)) || 1);
  try {
    const result = await listAgencyListingsPage(getConsoleDb(), view.actor, {
      // A member's view is the listings they are named on — what their desk shows.
      mine: Boolean(view.subject),
      limit: CONSOLE_PAGE_SIZE,
      offset: (pageNo - 1) * CONSOLE_PAGE_SIZE,
    });
    const pages = Math.max(1, Math.ceil(result.counts.total / CONSOLE_PAGE_SIZE));
    const web = WEB_URL();
    return (
      <div className={styles.wrap}>
        <SectionHead
          title="Listings"
          sub={`${result.counts.total} in total · ${result.counts.live} live · ${result.counts.pending} waiting for approval · ${result.counts.draft} drafts`}
        />
        <section className={styles.card}>
          {result.rows.length === 0 ? (
            <p className={styles.empty}>No listings.</p>
          ) : (
            <div className={styles.scroll}>
              <table className={styles.table}>
                <thead>
                  <tr><th>Address</th><th>Status</th><th>Price</th><th>Agents</th><th>Added</th></tr>
                </thead>
                <tbody>
                  {result.rows.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.status === 'live' || l.status === 'under_offer' || l.status === 'sold' ? (
                          <a className={styles.name} href={`${web}/listing/${l.id}`} target="_blank" rel="noopener">{l.address} ↗</a>
                        ) : (
                          <span className={styles.name}>{l.address}</span>
                        )}
                        <div className={styles.muted}>{l.suburb} {l.state} {l.postcode} · {l.channel}</div>
                      </td>
                      <td data-label="Status"><span className={STATUS_TONE[l.status] ?? styles.badge}>{l.status.replace('_', ' ')}</span></td>
                      <td data-label="Price">{l.priceDisplay ?? '—'}</td>
                      <td data-label="Agents">{l.agents.join(', ') || '—'}</td>
                      <td data-label="Added"><LocalTime iso={iso(l.createdAt)} style="date" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {pages > 1 ? (
          <div className={styles.filters}>
            {pageNo > 1 ? <Link className={styles.btn} href={`${base}/listings?page=${pageNo - 1}`}>← Newer</Link> : null}
            <span className={styles.muted}>Page {pageNo} of {pages}</span>
            {pageNo < pages ? <Link className={styles.btn} href={`${base}/listings?page=${pageNo + 1}`}>Older →</Link> : null}
          </div>
        ) : null}
      </div>
    );
  } catch (err) {
    return <Failed err={err} what="listings" />;
  }
}

// ── Team messages ─────────────────────────────────────────────────────────

export async function MessagesSection({ view, base, params }: Section) {
  const threadId = first(params.thread)?.trim() || null;
  await recordPlatformView(view.actor, threadId ? 'team_thread' : 'team_messages', threadId);
  const db = getConsoleDb();

  if (threadId) {
    try {
      const t = await getPlatformTeamThread(db, view.actor, threadId);
      return (
        <div className={styles.wrap}>
          <div className={styles.crumbs}><Link href={`${base}/messages`}>← Team messages</Link></div>
          <SectionHead title={t.subject} sub={t.people.join(', ')} />
          <section className={styles.card}>
            <div className={styles.messages}>
              {t.messages.map((m) => (
                <div key={m.id} className={styles.message}>
                  <div className={styles.messageMeta}>
                    <span className={styles.messageWho}>{m.senderName}</span>
                    <LocalTime iso={iso(m.createdAt)} />
                    {m.channel === 'email' ? <span className={styles.badge}>by email</span> : null}
                  </div>
                  <div className={styles.messageText}>{m.text}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      );
    } catch (err) {
      return <Failed err={err} what="that conversation" />;
    }
  }

  try {
    const rows = await listPlatformTeamThreads(db, view.actor);
    return (
      <div className={styles.wrap}>
        <SectionHead
          title="Team messages"
          sub={view.subject ? `The conversations ${view.subject.name} is on.` : 'Every conversation between members of the agency.'}
        />
        <section className={styles.card}>
          {rows.length === 0 ? (
            <p className={styles.empty}>No team conversations.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr><th>Subject</th><th>People</th><th className={styles.num}>Messages</th><th>Last</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className={styles.name} href={`${base}/messages?thread=${r.id}`}>{r.subject}</Link>
                      <div className={styles.muted}>{r.preview}</div>
                    </td>
                    <td data-label="People">{r.people.join(', ')}</td>
                    <td data-label="Messages" className={styles.num}>{r.messages}</td>
                    <td data-label="Last"><LocalTime iso={iso(r.lastMessageAt)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    );
  } catch (err) {
    return <Failed err={err} what="team messages" />;
  }
}

// ── Assistant chats (a member's only) ─────────────────────────────────────

export async function ChatsSection({ view, base, params }: Section) {
  const conversationId = first(params.c)?.trim() || null;
  await recordPlatformView(view.actor, conversationId ? 'assistant_chat' : 'assistant_chats', conversationId);
  const db = getConsoleDb();

  if (conversationId) {
    try {
      const chat = await getPlatformAssistantChat(db, view.actor, conversationId);
      return (
        <div className={styles.wrap}>
          <div className={styles.crumbs}><Link href={`${base}/chats`}>← Assistant chats</Link></div>
          <SectionHead title={chat.title} sub={`${chat.turns.length} ${chat.turns.length === 1 ? 'question' : 'questions'}`} />
          <section className={styles.card}>
            <div className={styles.messages}>
              {chat.turns.map((t) => (
                <div key={t.seq} style={{ display: 'grid', gap: '0.5rem' }}>
                  <div className={styles.ask}>
                    <div className={styles.messageMeta}>
                      <span className={styles.messageWho}>{view.subject?.name ?? 'Member'}</span>
                      <LocalTime iso={iso(t.createdAt)} />
                    </div>
                    <div className={styles.messageText}>{t.userText}</div>
                  </div>
                  <div className={styles.message}>
                    <div className={styles.messageMeta}>
                      <span className={styles.messageWho}>Assistant</span>
                      {t.status === 'failed' ? <span className={styles.badgeBad}>Failed</span> : null}
                    </div>
                    {t.answer ? <RichText text={t.answer} /> : <div className={styles.muted}>{t.error ?? '(no answer)'}</div>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      );
    } catch (err) {
      return <Failed err={err} what="that conversation" />;
    }
  }

  try {
    const rows = await listPlatformAssistantChats(db, view.actor);
    return (
      <div className={styles.wrap}>
        <SectionHead title="Assistant chats" sub={`${view.subject?.name ?? 'This member'}'s conversations with the assistant (kept 30 days).`} />
        <section className={styles.card}>
          {rows.length === 0 ? (
            <p className={styles.empty}>No assistant conversations.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr><th>Conversation</th><th>Console</th><th className={styles.num}>Questions</th><th>Last</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link className={styles.name} href={`${base}/chats?c=${r.id}`}>{r.title}</Link></td>
                    <td data-label="Console">{r.surface}</td>
                    <td data-label="Questions" className={styles.num}>{r.turnCount}</td>
                    <td data-label="Last"><LocalTime iso={iso(r.lastTurnAt)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    );
  } catch (err) {
    return <Failed err={err} what="assistant chats" />;
  }
}

// ── Workflows ─────────────────────────────────────────────────────────────

export async function WorkflowsSection({ view }: { view: PlatformView }) {
  await recordPlatformView(view.actor, 'workflows');
  try {
    const rows = await listWorkflows(getConsoleDb(), view.actor);
    return (
      <div className={styles.wrap}>
        <SectionHead
          title="Workflows"
          sub={view.subject ? `${view.subject.name}'s workflows (all of the agency's, if they run it).` : "Every workflow in the agency, archived ones left out."}
        />
        <section className={styles.card}>
          {rows.length === 0 ? (
            <p className={styles.empty}>No workflows.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr><th>Name</th><th>What it does</th><th>Owner</th><th>Status</th><th className={styles.num}>Runs today</th></tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id}>
                    <td><span className={styles.name}>{w.name}</span><div className={styles.muted}>{w.scope}</div></td>
                    <td data-label="What it does">
                      When {w.words.when}
                      {w.words.if.length ? <>, if {w.words.if.join(' and ')}</> : null}
                      {w.words.then.length ? <>: {w.words.then.join(', then ')}</> : null}
                    </td>
                    <td data-label="Owner">{w.ownerName}</td>
                    <td data-label="Status">
                      <span className={w.status === 'active' ? styles.badgeGood : styles.badgeWarn}>{w.status}</span>
                      {w.pausedReason ? <div className={styles.muted}>{w.pausedReason}</div> : null}
                    </td>
                    <td data-label="Runs today" className={styles.num}>{w.runsToday}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    );
  } catch (err) {
    return <Failed err={err} what="workflows" />;
  }
}
