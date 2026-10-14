import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import {
  ACTIVITY_LABELS,
  CONTACT_PROPERTY_RELATION_LABELS,
  CONTACT_ROLE_LABELS,
  CONTACT_SOURCE_LABELS,
  type ContactAssignee,
  type ContactCounts,
  type ContactPropertyView,
  type ContactTab,
  type ContactView,
  type NoteView,
  type TimelineItem,
} from '@repo/core/contacts';
import { ContactAssign } from './contact-assign';
import { ContactForm, type ContactFormValues } from './contact-form';
import {
  ArchiveButton,
  MergeButton,
  NextActionForm,
  NoteComposer,
  NoteControls,
  PropertyLinker,
  UnlinkButton,
} from './islands';
import { NewAddressLinker } from './new-address-linker';
import styles from './contacts.module.css';

/**
 * Contact 360 (ADR 0018, CRM Phase 2): one person, in tabs. Server components
 * throughout; the islands in ./islands are the only client code.
 *
 * Every control is drawn from a `may…` flag can() set in packages/core, and
 * every list arrived already scoped there — an agent's Enquiries, Emails and
 * Timeline hold only what their inbox would show them. Nothing here compares
 * a role (#2).
 */

const WHEN = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

const LEAD_WORD: Record<string, string> = {
  enquiry: 'Enquiry',
  inspection: 'Inspection request',
  appraisal: 'Appraisal request',
  offer: 'Private offer',
};

export function tabHref(basePath: string, id: string, tab: ContactTab, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (tab !== 'overview') p.set('tab', tab);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return `${basePath}/${id}${s ? `?${s}` : ''}`;
}

// ── The frame: header and tabs ─────────────────────────────────────────────

export function ContactFrame({
  contact: c,
  basePath,
  tab,
  counts,
  askHref,
  children,
}: {
  contact: ContactView;
  basePath: string;
  tab: ContactTab;
  counts: ContactCounts;
  /**
   * Where "Ask the assistant" goes, with this contact as its selection. Only
   * the agency console passes one: there the assistant is the home page, so it
   * has to be told the contact. The agent desk's panel reads it off this page.
   */
  askHref?: string;
  children: React.ReactNode;
}) {
  const tabs: { key: ContactTab; label: string; count?: number }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'timeline', label: 'Timeline' },
    { key: 'properties', label: 'Properties' },
    { key: 'emails', label: 'Emails', count: counts.conversations },
    { key: 'enquiries', label: 'Enquiries', count: counts.enquiries },
    { key: 'notes', label: 'Notes', count: counts.notes },
    { key: 'calendar', label: 'Calendar' },
    { key: 'reviews', label: 'Reviews' },
  ];

  return (
    <div className={styles.wrap}>
      <Link href={basePath} className={styles.back}>← All contacts</Link>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{c.name}</h1>
          <p className={styles.sub}>
            {[c.email, c.phone].filter(Boolean).join(' · ') || 'No email or phone yet'}
            {' · '}
            {CONTACT_SOURCE_LABELS[c.source]}, added {WHEN.format(c.createdAt)}
          </p>
        </div>
        <div className={styles.headActions}>
          {askHref ? (
            <Link href={askHref} className={styles.btn}>
              Ask the assistant
            </Link>
          ) : null}
          {c.mayUpdate ? (
            <Link href={tabHref(basePath, c.id, 'overview', { edit: '1' })} className={styles.btnGhost}>Edit</Link>
          ) : null}
          {c.mayArchive ? <ArchiveButton contactId={c.id} archived={Boolean(c.archivedAt)} /> : null}
        </div>
      </div>

      {c.archivedAt ? (
        <p className={styles.archivedBanner} role="note">
          Archived {WHEN.format(c.archivedAt)} — hidden from the contact list. Nothing was deleted; new
          enquiries from them still arrive here.
        </p>
      ) : null}

      <nav className={styles.tabs} aria-label="Contact sections">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={tabHref(basePath, c.id, t.key)}
            className={`${styles.tab} ${tab === t.key ? styles.tabOn : ''}`}
            aria-current={tab === t.key ? 'page' : undefined}
          >
            {t.label}
            {t.count ? <span className={styles.tabCount}>{t.count}</span> : null}
          </Link>
        ))}
      </nav>

      {children}
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────

export function OverviewTab({
  contact: c,
  basePath,
  editing,
  assignees,
  counts,
  recent,
}: {
  contact: ContactView;
  basePath: string;
  editing: boolean;
  assignees: ContactAssignee[];
  counts: ContactCounts;
  recent: TimelineItem[];
}) {
  if (editing && c.mayUpdate) {
    const initial: ContactFormValues = {
      name: c.name,
      email: c.email ?? '',
      phone: c.phone ?? '',
      roles: c.roles,
      nextAction: c.nextAction ?? '',
      nextActionAt: '',
      marketingConsent: Boolean(c.marketingConsent),
      marketingConsentNote: c.marketingConsent?.note ?? '',
    };
    return (
      <div className={styles.card}>
        <ContactForm
          mode="edit"
          contactId={c.id}
          initial={initial}
          basePath={basePath}
          nextActionAtIso={c.nextActionAt ? c.nextActionAt.toISOString() : null}
        />
      </div>
    );
  }

  return (
    <div className={styles.grid2}>
      <div className={styles.card}>
        <div className={styles.profile}>
          <dl className={styles.facts}>
            <dt>Email</dt>
            <dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className={styles.muted}>—</span>}</dd>
            <dt>Phone</dt>
            <dd>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : <span className={styles.muted}>—</span>}</dd>
            <dt>Roles</dt>
            <dd>
              {c.roles.length ? (
                <span className={styles.chips}>
                  {c.roles.map((r) => (
                    <span
                      key={r}
                      className={c.inferredRoles.includes(r) ? styles.chipInferred : styles.chip}
                      title={c.inferredRoles.includes(r) ? 'Read off what they did (e.g. an enquiry), not chosen by anyone' : undefined}
                    >
                      {CONTACT_ROLE_LABELS[r]}
                      {c.inferredRoles.includes(r) ? ' (inferred)' : ''}
                    </span>
                  ))}
                </span>
              ) : (
                <span className={styles.muted}>None yet</span>
              )}
            </dd>
            <dt>Assigned to</dt>
            <dd>
              {c.mayAssign ? (
                <ContactAssign contactId={c.id} assignedTo={c.assignedTo} assignees={assignees} />
              ) : (
                c.assigneeName ?? <span className={styles.muted}>Unassigned</span>
              )}
            </dd>
            <dt>Marketing email</dt>
            <dd>
              {c.emailOptOutAt ? (
                <>Opted out {WHEN.format(c.emailOptOutAt)}</>
              ) : c.marketingConsent ? (
                <>
                  Agreed {WHEN.format(c.marketingConsent.at)}
                  {c.marketingConsent.byName ? ` (recorded by ${c.marketingConsent.byName})` : ''}
                  {c.marketingConsent.note ? <span className={styles.muted}> — {c.marketingConsent.note}</span> : null}
                </>
              ) : (
                <span className={styles.muted}>No consent recorded — do not send marketing</span>
              )}
            </dd>
          </dl>
          {!c.mayUpdate ? (
            <p className={styles.note}>
              {c.mayNote
                ? 'You can see this contact because of a lead or listing of yours. You can add notes; only their assigned agent or an admin can edit them.'
                : 'You can view this contact but not change it.'}
            </p>
          ) : null}
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Next action</h2>
          {c.mayUpdate ? (
            <NextActionForm
              contactId={c.id}
              nextAction={c.nextAction ?? ''}
              nextActionAtIso={c.nextActionAt ? c.nextActionAt.toISOString() : null}
            />
          ) : c.nextAction ? (
            <p className={styles.note} style={{ color: 'var(--text-primary)' }}>
              {c.nextAction}
              {c.nextActionAt ? <span className={styles.muted}> · due <LocalTime iso={c.nextActionAt.toISOString()} /></span> : null}
            </p>
          ) : (
            <p className={styles.note}>None set.</p>
          )}
        </div>

        {c.possibleDuplicates.length ? (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Possible duplicates (same phone)</h2>
            <p className={styles.note}>
              Never merged automatically — a shared phone can be two people. Merging moves their enquiries,
              emails, notes and history onto this contact and hides theirs.
            </p>
            <ul className={styles.plainList}>
              {c.possibleDuplicates.map((d) => (
                <li key={d.id} className={styles.plainItem}>
                  <span>
                    <Link href={`${basePath}/${d.id}`}>{d.name}</Link>
                    <span className={styles.muted}> · {[d.email, d.phone].filter(Boolean).join(' · ')}</span>
                  </span>
                  {c.mayMerge ? <MergeButton survivorId={c.id} duplicateId={d.id} duplicateName={d.name} /> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div style={{ display: 'grid', gap: '1rem' }}>
        <div className={styles.stats}>
          <Link href={tabHref(basePath, c.id, 'enquiries')} className={styles.stat}>
            <span className={styles.statNum}>{counts.enquiries}</span>
            <span className={styles.statLabel}>Enquiries</span>
          </Link>
          <Link href={tabHref(basePath, c.id, 'emails')} className={styles.stat}>
            <span className={styles.statNum}>{counts.conversations}</span>
            <span className={styles.statLabel}>Conversations</span>
          </Link>
          <Link href={tabHref(basePath, c.id, 'notes')} className={styles.stat}>
            <span className={styles.statNum}>{counts.notes}</span>
            <span className={styles.statLabel}>Notes</span>
          </Link>
          <Link href={tabHref(basePath, c.id, 'properties')} className={styles.stat}>
            <span className={styles.statNum}>{counts.properties}</span>
            <span className={styles.statLabel}>Linked properties</span>
          </Link>
        </div>
        <div className={styles.card}>
          <div className={styles.section} style={{ borderTop: 0 }}>
            <h2 className={styles.sectionTitle}>Recent activity</h2>
            <TimelineList items={recent} basePath={basePath} contactId={c.id} />
            <Link href={tabHref(basePath, c.id, 'timeline')} className={styles.back}>Full timeline →</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Timeline ───────────────────────────────────────────────────────────────

const ICON: Record<TimelineItem['type'], string> = { lead: '✉︎', email: '↔', note: '✎', activity: '•' };

function activityText(item: Extract<TimelineItem, { type: 'activity' }>): string | null {
  const p = item.payload;
  switch (item.kind) {
    case 'role_added':
    case 'role_removed':
      return typeof p.role === 'string' && p.role in CONTACT_ROLE_LABELS
        ? CONTACT_ROLE_LABELS[p.role as keyof typeof CONTACT_ROLE_LABELS]
        : null;
    case 'contact_updated':
      return Array.isArray(p.fields) ? `Changed: ${p.fields.join(', ')}` : null;
    case 'property_linked':
      return [
        typeof p.address === 'string' ? p.address : null,
        typeof p.relation === 'string' && p.relation in CONTACT_PROPERTY_RELATION_LABELS
          ? `as ${CONTACT_PROPERTY_RELATION_LABELS[p.relation as keyof typeof CONTACT_PROPERTY_RELATION_LABELS]}`
          : null,
      ]
        .filter(Boolean)
        .join(' ');
    case 'contact_merged':
      return typeof p.name === 'string' ? `Merged ${p.name}${typeof p.email === 'string' ? ` (${p.email})` : ''}` : null;
    case 'consent_recorded':
    case 'consent_withdrawn':
      return typeof p.note === 'string' ? p.note : null;
    default:
      return null;
  }
}

export function TimelineList({
  items,
  basePath,
  contactId,
}: {
  items: TimelineItem[];
  basePath: string;
  contactId: string;
}) {
  if (!items.length) return <p className={styles.note}>Nothing yet.</p>;
  return (
    <ol className={styles.timeline}>
      {items.map((item) => (
        <li key={`${item.type}-${item.id}`} className={styles.event}>
          <span className={styles.eventIcon} aria-hidden>{ICON[item.type]}</span>
          <div>
            {item.type === 'lead' ? (
              <>
                <div className={styles.eventTitle}>
                  {LEAD_WORD[item.kind] ?? 'Enquiry'} about {item.address}
                </div>
                {item.message ? <div className={styles.eventBody}>{item.message}</div> : null}
                {item.threadId ? (
                  <Link href={tabHref(basePath, contactId, 'emails', { thread: item.threadId })} className={styles.back}>
                    Open conversation
                  </Link>
                ) : null}
              </>
            ) : item.type === 'email' ? (
              <>
                <div className={styles.eventTitle}>
                  {item.direction === 'in' ? 'Email from them' : `Email sent${item.who ? ` by ${item.who}` : ''}`}
                  {item.failed ? ' — not delivered' : ''}: {item.subject}
                </div>
                {item.preview ? <div className={styles.eventBody}>{item.preview}</div> : null}
                <Link href={tabHref(basePath, contactId, 'emails', { thread: item.threadId })} className={styles.back}>
                  Open conversation
                </Link>
              </>
            ) : item.type === 'note' ? (
              <>
                <div className={styles.eventTitle}>
                  Note{item.who ? ` by ${item.who}` : ''}
                  {item.isPrivate ? <> <span className={styles.chipInferred}>Private</span></> : null}
                </div>
                <div className={styles.eventBody}>{item.body}</div>
              </>
            ) : (
              <>
                <div className={styles.eventTitle}>
                  {ACTIVITY_LABELS[item.kind]}
                  {item.who ? <span className={styles.muted}> · {item.who}</span> : null}
                  {item.payload.via === 'assistant' ? <span className={styles.muted}> · via the assistant</span> : null}
                </div>
                {activityText(item) ? <div className={styles.eventBody}>{activityText(item)}</div> : null}
              </>
            )}
          </div>
          <span className={styles.eventMeta}>
            <LocalTime iso={item.at.toISOString()} style="short" />
          </span>
        </li>
      ))}
    </ol>
  );
}

// ── Properties ─────────────────────────────────────────────────────────────

export function PropertiesTab({
  contact: c,
  properties,
  webUrl,
}: {
  contact: ContactView;
  properties: ContactPropertyView[];
  webUrl: string;
}) {
  return (
    <div className={styles.card}>
      <div className={styles.section} style={{ borderTop: 0 }}>
        {properties.length === 0 ? (
          <p className={styles.note}>No properties yet. Addresses they enquire about appear here automatically.</p>
        ) : (
          <ul className={styles.plainList}>
            {properties.map((p) => (
              <li key={p.propertyId} className={styles.plainItem}>
                <span style={{ display: 'grid', gap: '0.25rem' }}>
                  {/*
                    The public property page. It shows the address's history
                    when nothing there is on the market, and sends a visitor
                    on to the live ad when something is (ADR 0013).
                  */}
                  <a href={`${webUrl}/property/${p.propertyId}`} target="_blank" rel="noopener" className={styles.name}>
                    {p.address} ↗
                  </a>
                  <span className={styles.chips}>
                    {p.links.map((l) => (
                      <span key={l.id} className={styles.chip} title={l.note ?? undefined}>
                        {CONTACT_PROPERTY_RELATION_LABELS[l.relation]}
                        {c.mayUpdate ? <> <UnlinkButton contactId={c.id} linkId={l.id} /></> : null}
                      </span>
                    ))}
                    {p.leadKinds.map((k) => (
                      <span key={k} className={styles.chipInferred} title="From their enquiry — not linked by hand">
                        {LEAD_WORD[k] ?? k}
                      </span>
                    ))}
                  </span>
                </span>
                {p.listingId ? (
                  <a href={`${webUrl}/listing/${p.listingId}`} target="_blank" rel="noopener" className={styles.back}>
                    The ad they asked about ↗
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      {c.mayUpdate ? (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Link a property</h2>
          <PropertyLinker contactId={c.id} />
          <NewAddressLinker contactId={c.id} />
        </div>
      ) : null}
    </div>
  );
}

// ── Notes ──────────────────────────────────────────────────────────────────

export function NotesTab({ contact: c, notes }: { contact: ContactView; notes: NoteView[] }) {
  return (
    <div className={styles.card}>
      {c.mayNote ? (
        <div className={styles.section} style={{ borderTop: 0 }}>
          <NoteComposer contactId={c.id} />
        </div>
      ) : null}
      <div className={styles.section} style={c.mayNote ? undefined : { borderTop: 0 }}>
        {notes.length === 0 ? (
          <p className={styles.note}>No notes yet.</p>
        ) : (
          <ol className={styles.timeline}>
            {notes.map((n) => (
              <li key={n.id} className={styles.event}>
                <span className={styles.eventIcon} aria-hidden>✎</span>
                <div>
                  <div className={styles.eventTitle}>
                    {n.authorName ?? 'Someone'}
                    {n.editedAt ? <span className={styles.muted}> · edited</span> : null}
                    {n.isPrivate ? <> <span className={styles.chipInferred} title="Only admins and the author see this">Private</span></> : null}
                  </div>
                  {n.mayManage ? (
                    <>
                      <div className={styles.eventBody}>{n.body}</div>
                      <NoteControls noteId={n.id} body={n.body} isPrivate={n.isPrivate} />
                    </>
                  ) : (
                    <div className={styles.eventBody}>{n.body}</div>
                  )}
                </div>
                <span className={styles.eventMeta}>
                  <LocalTime iso={n.createdAt.toISOString()} style="short" />
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// ── Not connected yet ──────────────────────────────────────────────────────

export function NotConnected({ which }: { which: 'google-calendar' | 'zoom' | 'reviews' }) {
  const copy = {
    'google-calendar': {
      name: 'Google Calendar',
      what: 'Appointments booked here will also appear in your Google Calendar once it is connected. Until then they live only in this calendar.',
    },
    zoom: {
      name: 'Zoom',
      what: 'Once Zoom is connected, a Zoom appointment creates its meeting link by itself. Until then, paste a link into the appointment.',
    },
    reviews: {
      name: 'Google Business Profile',
      what: "Reviews this person left for the agency will show here once the agency's Google Business Profile is connected and a review is matched to them. A review is only attached to a person when the match is confirmed.",
    },
  }[which];
  return (
    <div className={styles.card}>
      <div className={styles.connect}>
        <div className={styles.connectHead}>
          <strong>{copy.name}</strong>
          <span className={styles.statusOff}>Not connected</span>
        </div>
        <p className={styles.note}>{copy.what}</p>
        <p className={styles.note}>Connecting integrations arrives with Settings → Connectors (a later phase).</p>
      </div>
    </div>
  );
}
