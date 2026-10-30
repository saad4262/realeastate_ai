import Link from 'next/link';
import { getMyPhone, getSmsConversation, listSmsConversations, PhoneError, type SmsConversationView } from '@repo/core/phone';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { keysOrNull } from './phone-setup-screen';
import { NewTextForm, SmsComposer } from './sms-composer';
import styles from './phone.module.css';

/**
 * Inbox → Texts (ADR 0070): the conversations on the agents' Twilio numbers. An agent sees their own;
 * owners and admins every number's, to read. Only a number's own agent texts from it. `?n=&with=`
 * opens one conversation (and marks it read for this person); `?new=1` starts one.
 */
export async function TextsScreen({ surface, searchParams }: { surface: 'agency' | 'agent'; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireConsoleAccess(surface);
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const base = surface === 'agency' ? '/inbox/texts' : '/my-inbox/texts';
  const inboxHref = surface === 'agency' ? '/inbox' : '/my-inbox';
  const db = getConsoleDb();

  let rows: Awaited<ReturnType<typeof listSmsConversations>> = [];
  let loadError: string | null = null;
  try {
    rows = await listSmsConversations(db, session.actor);
  } catch (err) {
    loadError = err instanceof PhoneError ? err.message : 'Could not load texts.';
  }
  const me = await getMyPhone(db, session.actor, { keys: keysOrNull() }).catch(() => null);
  const canStart = Boolean(me?.number);

  const n = first(sp.n);
  const withNumber = first(sp.with);
  let open: SmsConversationView | null = null;
  let openError: string | null = null;
  if (n && withNumber) {
    try {
      open = await getSmsConversation(db, session.actor, n, withNumber);
    } catch (err) {
      openError = err instanceof PhoneError ? err.message : 'Could not open that conversation.';
    }
  }
  const starting = first(sp.new) === '1';

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <div className={styles.row}>
          <Link href={inboxHref} className={styles.btn}>Email</Link>
          <span className={`${styles.btn} ${styles.btnPrimary}`} aria-current="page">Texts</span>
          {canStart ? <Link href={`${base}?new=1`} className={styles.btn} style={{ marginLeft: 'auto' }}>New text</Link> : null}
        </div>
        <h1 className={contactStyles.title}>Texts</h1>
        <p className={contactStyles.sub}>
          {surface === 'agency'
            ? 'Texts on your agents’ Twilio numbers. You can read every conversation; only the agent whose number it is can reply.'
            : me?.number
              ? `Texts to and from your number ${me.number.display}.`
              : 'You don’t have a Twilio number yet, so there’s nothing to text from. See Connectors → My phone.'}
        </p>
      </div>
      {loadError ? <p role="alert">{loadError}</p> : null}

      <div className={styles.texts}>
        <nav className={styles.convList} aria-label="Conversations">
          {rows.length === 0 ? (
            <p className={styles.muted} style={{ padding: '0.85rem' }}>No texts yet.</p>
          ) : (
            rows.map((r) => {
              const on = open?.phoneNumberId === r.phoneNumberId && open?.counterpart === r.counterpart;
              return (
                <Link
                  key={`${r.phoneNumberId}|${r.counterpart}`}
                  href={`${base}?n=${r.phoneNumberId}&with=${encodeURIComponent(r.counterpart)}`}
                  className={`${styles.conv} ${on ? styles.convOn : ''} ${r.unread ? styles.convUnread : ''}`}
                  aria-current={on ? 'page' : undefined}
                >
                  <span className={styles.convTop}>
                    <span className={styles.convName}>{r.contactName ?? r.display}</span>
                    <span className={styles.muted}>{r.lastAt.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                  </span>
                  <span className={styles.convBody}>{r.lastDirection === 'out' ? 'You: ' : ''}{r.lastBody}</span>
                  {surface === 'agency' ? <span className={styles.muted}>{r.agentName}’s number</span> : null}
                </Link>
              );
            })
          )}
        </nav>

        <section className={styles.thread} aria-label="Conversation">
          {starting && canStart ? (
            <NewTextForm base={base} />
          ) : openError ? (
            <p role="alert">{openError}</p>
          ) : open ? (
            <>
              <div className={styles.row}>
                <b>{open.contact?.name ?? open.display}</b>
                <span className={styles.muted} style={{ marginLeft: 0 }}>{open.display} · on {open.agentName}’s number {open.numberDisplay}</span>
                {open.contact ? <Link href={`${surface === 'agency' ? '/customers' : '/my-contacts'}/${open.contact.id}`} className={styles.btnLink} style={{ marginLeft: 'auto' }}>Open contact</Link> : null}
              </div>
              <div className={styles.bubbles}>
                {open.messages.map((m) => (
                  <div key={m.id} className={`${styles.bubble} ${m.direction === 'in' ? styles.bubbleIn : styles.bubbleOut}`}>
                    {m.body}
                    <span className={styles.bubbleMeta}>
                      {m.at.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                      {m.direction === 'out'
                        ? ` · ${m.kind === 'missed_call_text' ? 'Automatic missed-call text' : (m.byName ?? 'sent')} · ${m.status === 'failed' || m.status === 'undelivered' ? `not delivered${m.error ? `: ${m.error}` : ''}` : m.status}`
                        : ''}
                    </span>
                  </div>
                ))}
              </div>
              {open.optedOut ? (
                <p className={`${styles.note} ${styles.noteWarn}`}>
                  <span className={styles.glyph} aria-hidden>block</span>
                  <span>This number replied STOP, so nobody at the agency can text it. If they text START, texts are allowed again.</span>
                </p>
              ) : open.canSend ? (
                <SmsComposer to={open.counterpart} />
              ) : (
                <p className={styles.muted}>Only {open.agentName} can reply from their number.</p>
              )}
            </>
          ) : (
            <p className={styles.muted}>Pick a conversation{canStart ? ', or start a new text.' : '.'}</p>
          )}
        </section>
      </div>
    </div>
  );
}
