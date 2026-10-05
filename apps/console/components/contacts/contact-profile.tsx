import Link from 'next/link';
import {
  CONTACT_ROLE_LABELS,
  CONTACT_SOURCE_LABELS,
  type ContactAssignee,
  type ContactView,
} from '@repo/core/contacts';
import { ContactAssign } from './contact-assign';
import { ContactForm, type ContactFormValues } from './contact-form';
import styles from './contacts.module.css';

const WHEN = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
const WHEN_TIME = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** A Date as the `datetime-local` input wants it, in the server's zone. */
function localInput(d: Date | null): string {
  if (!d) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * One contact (ADR 0018) — the Phase 1 card: who they are, how to reach them,
 * what they are to the agency, whose they are, consent, and possible
 * duplicates. The Contact 360 tabs (properties, emails, enquiries, notes,
 * calendar, reviews) are Phase 2.
 *
 * Every control here is drawn from a `may…` flag can() set in packages/core;
 * the actions re-check. Nothing compares a role (#2).
 */
export function ContactProfile({
  contact: c,
  basePath,
  editing,
  assignees,
}: {
  contact: ContactView;
  basePath: string;
  editing: boolean;
  assignees: ContactAssignee[];
}) {
  const initial: ContactFormValues = {
    name: c.name,
    email: c.email ?? '',
    phone: c.phone ?? '',
    roles: c.roles,
    nextAction: c.nextAction ?? '',
    nextActionAt: localInput(c.nextActionAt),
    marketingConsent: Boolean(c.marketingConsent),
    marketingConsentNote: c.marketingConsent?.note ?? '',
  };

  return (
    <div className={styles.wrap}>
      <Link href={basePath} className={styles.back}>← All contacts</Link>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{c.name}</h1>
          <p className={styles.sub}>
            {CONTACT_SOURCE_LABELS[c.source]} · added {WHEN.format(c.createdAt)}
          </p>
        </div>
        {c.mayUpdate && !editing ? (
          <Link href={`${basePath}/${c.id}?edit=1`} className={styles.btnGhost}>Edit</Link>
        ) : null}
      </div>

      <div className={styles.card}>
        {editing && c.mayUpdate ? (
          <ContactForm mode="edit" contactId={c.id} initial={initial} basePath={basePath} />
        ) : (
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
              <dt>Next action</dt>
              <dd>
                {c.nextAction ? (
                  <>
                    {c.nextAction}
                    {c.nextActionAt ? <span className={styles.muted}> · due {WHEN_TIME.format(c.nextActionAt)}</span> : null}
                  </>
                ) : (
                  <span className={styles.muted}>—</span>
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
                You can see this contact because of a lead or listing of yours. Only their assigned agent or an admin can edit it.
              </p>
            ) : null}
          </div>
        )}

        {c.possibleDuplicates.length ? (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Possible duplicates (same phone)</h2>
            <p className={styles.note}>
              Not merged automatically — a shared phone can be two people. Merging arrives with the full profile.
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.8125rem' }}>
              {c.possibleDuplicates.map((d) => (
                <li key={d.id}>
                  <Link href={`${basePath}/${d.id}`}>{d.name}</Link>
                  <span className={styles.muted}> · {[d.email, d.phone].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Coming next</h2>
          <p className={styles.note}>
            Properties, emails, enquiries, notes, appointments and reviews for this person arrive with the full
            profile (Phase 2).
          </p>
        </div>
      </div>
    </div>
  );
}
